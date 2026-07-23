import argparse
import inspect
import json
import math
import statistics
import sys
from pathlib import Path

import Metashape

import export_colmap

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.colmap_backend import apply_colmap_ground_alignment


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--export-dir", required=True)
    p.add_argument("--keypoint-limit", type=int, default=40000)
    p.add_argument("--tiepoint-limit", type=int, default=0)
    p.add_argument("--up-axis", default="+Y")
    return p.parse_args(sys.argv[1:])


def emit_progress(value):
    print(f"PROGRESS:{int(value)}", flush=True)


def load_manifest(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _gpu_device_name(device):
    if isinstance(device, str):
        return device
    for attr in ("name", "label", "vendor", "renderer"):
        try:
            value = getattr(device, attr)
        except Exception:
            continue
        if value:
            return str(value)
    return str(device)


def configure_gpu_preference():
    try:
        devices = list(Metashape.app.enumGPUDevices())
    except Exception as exc:
        print(f"WARN: Metashape GPU enumeration failed: {exc}", flush=True)
        return

    if not devices:
        print("WARN: Metashape did not report GPU devices; using default compute settings", flush=True)
        return

    names = [_gpu_device_name(device) for device in devices]
    dedicated_keywords = ("nvidia", "geforce", "rtx", "gtx", "quadro", "tesla", "amd", "radeon", "rx ")
    integrated_keywords = ("intel", "uhd", "iris", "arc", "integrated", "microsoft basic")
    selected = []
    for index, name in enumerate(names):
        lowered = name.lower()
        if any(word in lowered for word in dedicated_keywords) and not any(word in lowered for word in integrated_keywords):
            selected.append(index)

    if not selected:
        selected = [
            index
            for index, name in enumerate(names)
            if not any(word in name.lower() for word in integrated_keywords)
        ]

    if not selected:
        print(f"WARN: No dedicated Metashape GPU found; devices={names}", flush=True)
        return

    mask = 0
    for index in selected:
        mask |= 1 << index

    try:
        Metashape.app.gpu_mask = mask
        try:
            Metashape.app.cpu_enable = False
        except Exception:
            pass
        chosen = [names[index] for index in selected]
        print(f"Metashape GPU selected: mask={mask}, devices={chosen}", flush=True)
    except Exception as exc:
        print(f"WARN: Failed to set Metashape GPU preference: {exc}; devices={names}", flush=True)


def copy_sensor_geometry(dst, src):
    if not src:
        return
    dst.width = src.width
    dst.height = src.height
    dst.pixel_width = src.pixel_width
    dst.pixel_height = src.pixel_height
    dst.focal_length = src.focal_length
    try:
        dst.calibration = src.calibration
    except Exception:
        pass


def configure_fisheye_sensor(sensor):
    sensor.type = Metashape.Sensor.Type.EquidistantFisheye
    # An equidistant 180-degree lens has r = f * pi/2. Use image geometry as
    # the neutral initial calibration instead of pretending every DJI/Insta360
    # model has the same 2.4um pixels and 2.5mm focal length.
    image_size = min(int(getattr(sensor, "width", 0) or 0), int(getattr(sensor, "height", 0) or 0))
    sensor.pixel_width = 1.0
    sensor.pixel_height = 1.0
    sensor.focal_length = (image_size / math.pi) if image_size > 0 else 1000.0
    calib = sensor.calibration
    if calib:
        calib.f = sensor.focal_length / sensor.pixel_width
        calib.cx = 0.0
        calib.cy = 0.0
        calib.b1 = 0
        calib.b2 = 0
        calib.k4 = 0
        calib.type = Metashape.Sensor.Type.EquidistantFisheye
    # Keep the physical intrinsics flexible during bundle adjustment. Export
    # uses this same calibration so image pixels, rays and tie points remain
    # geometrically consistent.
    sensor.fixed_params = ["B1", "B2", "K4"]


def make_track_sensor(chunk, source_camera, label, sensor_type):
    sensor = chunk.addSensor()
    sensor.label = label
    copy_sensor_geometry(sensor, source_camera.sensor if source_camera else None)
    sensor.type = sensor_type
    if sensor_type == Metashape.Sensor.Type.EquidistantFisheye:
        configure_fisheye_sensor(sensor)
    elif sensor_type == Metashape.Sensor.Type.Frame:
        calib = sensor.calibration
        if calib:
            calib.type = Metashape.Sensor.Type.Frame
            for attr in ("k1", "k2", "k3", "k4", "p1", "p2", "b1", "b2"):
                try:
                    setattr(calib, attr, 0.0)
                except Exception:
                    pass
    return sensor


def camera_path_name(camera):
    try:
        return Path(camera.photo.path).name.lower()
    except Exception:
        return camera.label.lower()


def source_path_key(path):
    try:
        return str(Path(path).resolve()).casefold()
    except Exception:
        return str(Path(path)).casefold()


def camera_path_key(camera):
    try:
        return source_path_key(camera.photo.path)
    except Exception:
        return ""


def add_photos_get_new(chunk, paths, group_key=None):
    before_keys = {camera.key for camera in chunk.cameras}
    expected_by_path = {source_path_key(path): index for index, path in enumerate(paths)}
    kwargs = {"load_xmp_accuracy": True}
    if group_key is not None:
        kwargs["group"] = group_key
    chunk.addPhotos([str(p) for p in paths], **kwargs)
    new_cameras = [camera for camera in chunk.cameras if camera.key not in before_keys]

    unexpected = [camera for camera in new_cameras if camera_path_key(camera) not in expected_by_path]
    if unexpected:
        names = ", ".join(camera_path_name(camera) for camera in unexpected[:5])
        raise RuntimeError(f"Metashape returned unexpected cameras after addPhotos: {names}")

    if len(new_cameras) != len(paths):
        imported = {camera_path_key(camera) for camera in new_cameras}
        missing = [str(path) for path in paths if source_path_key(path) not in imported]
        raise RuntimeError(
            "Metashape did not import the expected camera set; missing: "
            + ", ".join(missing[:5])
        )

    return sorted(new_cameras, key=lambda camera: expected_by_path[camera_path_key(camera)])


def add_multiplane_photos_get_pairs(chunk, frames):
    """Import synchronized left/right frames as a native Metashape camera rig."""
    paths = [path for frame in frames for path in (frame["left"], frame["right"])]
    before_keys = {camera.key for camera in chunk.cameras}
    expected_by_path = {source_path_key(path): index for index, path in enumerate(paths)}
    chunk.addPhotos(
        filenames=[str(path) for path in paths],
        filegroups=[2] * len(frames),
        layout=Metashape.MultiplaneLayout,
        load_xmp_accuracy=True,
    )
    new_cameras = [camera for camera in chunk.cameras if camera.key not in before_keys]
    new_cameras.sort(key=lambda camera: expected_by_path.get(camera_path_key(camera), len(paths)))
    if len(new_cameras) != len(paths) or any(camera_path_key(c) not in expected_by_path for c in new_cameras):
        imported = {camera_path_key(camera) for camera in new_cameras}
        missing = [str(path) for path in paths if source_path_key(path) not in imported]
        raise RuntimeError(
            "Metashape did not import the expected multiplane camera set; missing: "
            + ", ".join(missing[:5])
        )

    pairs = []
    for index, frame in enumerate(frames):
        left, right = new_cameras[index * 2:index * 2 + 2]
        if right.master != left or left.master != left:
            raise RuntimeError(
                f"Metashape did not create a persistent master/slave pair for {frame.get('frame_id', index)}"
            )
        pairs.append((left, right))
    return pairs

def import_panorama_track(chunk, track, sensor_cache):
    frames = track.get("frames", [])
    if not frames:
        return []
    pairs = add_multiplane_photos_get_pairs(chunk, frames)
    profile = track.get("device_profile") or track["track_id"]
    left_label = f"{profile}_left"
    right_label = f"{profile}_right"
    cached = sensor_cache.get(profile)
    if cached:
        left_sensor, right_sensor = cached
        for left, right in pairs:
            if (left.width, left.height) != (left_sensor.width, left_sensor.height):
                raise RuntimeError(f"Device profile {profile!r} mixes incompatible left image sizes")
            if (right.width, right.height) != (right_sensor.width, right_sensor.height):
                raise RuntimeError(f"Device profile {profile!r} mixes incompatible right image sizes")
            left.sensor = left_sensor
            right.sensor = right_sensor
    else:
        left_sensor, right_sensor = pairs[0][0].sensor, pairs[0][1].sensor
        left_sensor.label = left_label
        right_sensor.label = right_label
        configure_fisheye_sensor(left_sensor)
        configure_fisheye_sensor(right_sensor)
        left_sensor.makeMaster()
        if right_sensor.master != left_sensor:
            raise RuntimeError(f"Metashape did not preserve the sensor rig for {profile!r}")
        right_sensor.location = Metashape.Vector([0.0, 0.0, 0.0])
        right_sensor.fixed_location = True

    sensor_cache[profile] = (left_sensor, right_sensor)
    return pairs


def import_photo_track(chunk, track):
    group = chunk.addCameraGroup()
    group.label = track.get("group_label", f"{track['track_id']}_photos")
    group.type = Metashape.CameraGroup.Type.Folder

    photo_sensors = track.get("photo_sensors") or []
    if photo_sensors:
        imported = []
        for sensor_group in photo_sensors:
            photos = sensor_group.get("photos", [])
            if not photos:
                continue
            new_cameras = add_photos_get_new(chunk, photos, group_key=group.key)
            if not new_cameras:
                continue
            sensor = make_track_sensor(
                chunk,
                new_cameras[0],
                sensor_group.get("sensor_label", track.get("sensor_label", f"{track['track_id']}_frame")),
                Metashape.Sensor.Type.Frame,
            )
            for camera in new_cameras:
                camera.sensor = sensor
            imported.extend(new_cameras)
        return imported

    photos = track.get("photos", [])
    if not photos:
        return []
    new_cameras = add_photos_get_new(chunk, photos, group_key=group.key)
    sensors_by_size = {}
    base_label = track.get("sensor_label", f"{track['track_id']}_frame")
    for camera in new_cameras:
        src = camera.sensor
        key = (getattr(src, "width", 0), getattr(src, "height", 0))
        if key not in sensors_by_size:
            suffix = "" if not sensors_by_size else f"_{len(sensors_by_size) + 1:02d}"
            sensor = make_track_sensor(chunk, camera, f"{base_label}{suffix}", Metashape.Sensor.Type.Frame)
            sensors_by_size[key] = sensor
        camera.sensor = sensors_by_size[key]
    return new_cameras


def import_manifest_tracks(chunk, manifest, track_types=None, sensor_cache=None):
    sensor_cache = sensor_cache if sensor_cache is not None else {}
    panorama_pairs = []
    for track in manifest.get("tracks", []):
        track_type = track.get("track_type")
        if track_types is not None and track_type not in track_types:
            continue
        if track_type == "panorama_video":
            panorama_pairs.extend(import_panorama_track(chunk, track, sensor_cache))
        elif track_type in {"standard_photos", "aerial_photos"}:
            import_photo_track(chunk, track)
        else:
            raise RuntimeError(f"Unsupported track_type: {track_type}")
    prune_unused_sensors(chunk)
    return panorama_pairs


def used_sensors(chunk):
    sensors = []
    seen = set()
    for camera in chunk.cameras:
        if camera.sensor and camera.sensor.key not in seen:
            sensors.append(camera.sensor)
            seen.add(camera.sensor.key)
    return sensors


def prune_unused_sensors(chunk):
    used = {sensor.key for sensor in used_sensors(chunk)}
    for sensor in list(chunk.sensors):
        if sensor.key not in used:
            try:
                chunk.remove(sensor)
            except Exception:
                pass


_HAS_RESET_ALIGNMENT = None


def _supports_reset_alignment():
    global _HAS_RESET_ALIGNMENT
    if _HAS_RESET_ALIGNMENT is None:
        try:
            sig = inspect.signature(Metashape.Chunk.alignCameras)
            _HAS_RESET_ALIGNMENT = "reset_alignment" in sig.parameters
        except Exception:
            _HAS_RESET_ALIGNMENT = False
    return _HAS_RESET_ALIGNMENT


def rig_baselines(chunk, panorama_pairs):
    distances = []
    for left, right in panorama_pairs:
        if not left.transform or not right.transform:
            continue
        centers = [chunk.transform.matrix.mulp(camera.center) for camera in (left, right)]
        delta = centers[0] - centers[1]
        distances.append(math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z))
    return distances


def _relative_rotation(left_camera, right_camera):
    left_rotation = left_camera.transform.rotation()
    right_rotation = right_camera.transform.rotation()
    return right_rotation * left_rotation.inv()


def _rotation_angle_degrees(rotation):
    trace = rotation[0, 0] + rotation[1, 1] + rotation[2, 2]
    cosine = max(-1.0, min(1.0, (trace - 1.0) * 0.5))
    return math.degrees(math.acos(cosine))


def _percentile(values, fraction):
    values = sorted(values)
    if not values:
        return 0.0
    index = min(len(values) - 1, max(0, int(math.ceil(fraction * len(values)) - 1)))
    return values[index]


def reprojection_error_statistics(chunk):
    """Measure the pixel residuals of the solved tie-point observations."""
    tie_points = getattr(chunk, "tie_points", None)
    empty = {
        "count": 0,
        "median_pixels": None,
        "p95_pixels": None,
        "p99_pixels": None,
        "max_pixels": None,
    }
    if not tie_points:
        return empty

    points_by_track = {
        point.track_id: point
        for point in tie_points.points
        if point.valid
    }
    errors = []
    for camera in chunk.cameras:
        if not camera.transform:
            continue
        try:
            projections = tie_points.projections[camera]
        except (KeyError, RuntimeError):
            continue
        for projection in projections:
            point = points_by_track.get(projection.track_id)
            if point is None:
                continue
            predicted = camera.project(point.coord)
            if predicted is None:
                continue
            delta = predicted - projection.coord
            errors.append(math.hypot(delta.x, delta.y))

    if not errors:
        return empty
    return {
        "count": len(errors),
        "median_pixels": statistics.median(errors),
        "p95_pixels": _percentile(errors, 0.95),
        "p99_pixels": _percentile(errors, 0.99),
        "max_pixels": max(errors),
    }


def _matrix_to_quaternion(matrix):
    m00, m11, m22 = matrix[0, 0], matrix[1, 1], matrix[2, 2]
    trace = m00 + m11 + m22
    if trace > 0.0:
        scale = math.sqrt(trace + 1.0) * 2.0
        quat = (
            0.25 * scale,
            (matrix[2, 1] - matrix[1, 2]) / scale,
            (matrix[0, 2] - matrix[2, 0]) / scale,
            (matrix[1, 0] - matrix[0, 1]) / scale,
        )
    elif m00 > m11 and m00 > m22:
        scale = math.sqrt(1.0 + m00 - m11 - m22) * 2.0
        quat = (
            (matrix[2, 1] - matrix[1, 2]) / scale,
            0.25 * scale,
            (matrix[0, 1] + matrix[1, 0]) / scale,
            (matrix[0, 2] + matrix[2, 0]) / scale,
        )
    elif m11 > m22:
        scale = math.sqrt(1.0 + m11 - m00 - m22) * 2.0
        quat = (
            (matrix[0, 2] - matrix[2, 0]) / scale,
            (matrix[0, 1] + matrix[1, 0]) / scale,
            0.25 * scale,
            (matrix[1, 2] + matrix[2, 1]) / scale,
        )
    else:
        scale = math.sqrt(1.0 + m22 - m00 - m11) * 2.0
        quat = (
            (matrix[1, 0] - matrix[0, 1]) / scale,
            (matrix[0, 2] + matrix[2, 0]) / scale,
            (matrix[1, 2] + matrix[2, 1]) / scale,
            0.25 * scale,
        )
    norm = math.sqrt(sum(value * value for value in quat))
    return tuple(value / norm for value in quat)


def _quaternion_to_matrix(quaternion):
    w, x, y, z = quaternion
    return Metashape.Matrix([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def estimate_rig_rotation(chunk, pairs):
    rotations = []
    for left, right in pairs:
        if left.transform and right.transform:
            rotations.append(_relative_rotation(left, right))
    if len(rotations) < 3:
        raise RuntimeError(f"Need at least 3 aligned dual-fisheye pairs to estimate a rigid rig; got {len(rotations)}")

    def median_rotation(items):
        quaternions = [_matrix_to_quaternion(rotation) for rotation in items]
        reference = quaternions[0]
        aligned = [
            tuple(-value for value in quaternion)
            if sum(a * b for a, b in zip(quaternion, reference)) < 0.0
            else quaternion
            for quaternion in quaternions
        ]
        median = tuple(
            statistics.median(quaternion[axis] for quaternion in aligned)
            for axis in range(4)
        )
        norm = math.sqrt(sum(value * value for value in median))
        if norm <= 1e-12:
            raise RuntimeError("Rigid-rig quaternion average is degenerate")
        return _quaternion_to_matrix(tuple(value / norm for value in median))

    estimate = median_rotation(rotations)
    deviations = [_rotation_angle_degrees(rotation * estimate.inv()) for rotation in rotations]
    median_dev = statistics.median(deviations)
    mad = statistics.median(abs(value - median_dev) for value in deviations)
    cutoff = max(1.0, median_dev + 3.0 * max(mad, 0.05))
    inliers = [rotation for rotation, deviation in zip(rotations, deviations) if deviation <= cutoff]
    if len(inliers) < 3:
        raise RuntimeError("Rigid-rig calibration rejected too many relative-rotation samples")
    estimate = median_rotation(inliers)
    deviations = [_rotation_angle_degrees(rotation * estimate.inv()) for rotation in rotations]
    return estimate, {
        "samples": len(rotations),
        "inliers": len(inliers),
        "median_deviation_degrees": statistics.median(deviations),
        "p95_deviation_degrees": _percentile(deviations, 0.95),
        "max_deviation_degrees": max(deviations),
    }


def configure_rigid_rigs(chunk, pairs, sensor_cache):
    reports = {}
    pairs_by_profile = {}
    for pair in pairs:
        profile = pair[0].sensor.label[:-5]
        pairs_by_profile.setdefault(profile, []).append(pair)

    for profile, profile_pairs in pairs_by_profile.items():
        left_sensor, right_sensor = sensor_cache[profile]
        if right_sensor.master != left_sensor or right_sensor.rotation is None:
            raise RuntimeError(
                f"Metashape could not estimate the native multiplane rig rotation for {profile!r}"
            )
        right_sensor.fixed_location = True
        right_sensor.fixed_rotation = True
        malformed = [
            right.label for left, right in profile_pairs
            if left.master != left or right.master != left
        ]
        if malformed:
            raise RuntimeError(
                f"Native multiplane master/slave relationship was lost for {len(malformed)} cameras"
            )
        aligned_pairs = sum(1 for left, right in profile_pairs if left.transform and right.transform)
        report = {
            "profile": profile,
            "groups": len(profile_pairs),
            "samples": aligned_pairs,
            "inliers": aligned_pairs,
            # Native MultiplaneLayout stores one sensor transform shared by all
            # frames, so per-frame rig spread is structurally zero. Camera
            # transforms use master/slave semantics and must not be differenced
            # as if they were independent poses.
            "median_deviation_degrees": 0.0,
            "p95_deviation_degrees": 0.0,
            "max_deviation_degrees": 0.0,
            "rotation_rvec": [
                float(value) for value in Metashape.utils.mat2rvec(right_sensor.rotation)
            ],
            "native_multiplane": True,
        }
        report["rotation_angle_degrees"] = math.degrees(
            math.sqrt(sum(value * value for value in report["rotation_rvec"]))
        )
        reports[profile] = report
        print(
            f"Rigid rig {profile}: {report['inliers']}/{report['samples']} inliers, "
            f"p95={report['p95_deviation_degrees']:.3f} deg",
            flush=True,
        )
    if not reports:
        raise RuntimeError("No panorama device profiles were available for rigid-rig configuration")
    return reports


def evaluate_alignment_quality(chunk, panorama_pairs, rig_reports, manifest=None):
    total = len(chunk.cameras)
    aligned = sum(1 for camera in chunk.cameras if camera.transform)
    expected_total = None
    if manifest is not None:
        expected_total = sum(
            2 * len(track.get("frames", []))
            if track.get("track_type") == "panorama_video"
            else len(track.get("photos", []))
            for track in manifest.get("tracks", [])
        )
    valid_pairs = 0
    malformed_groups = []
    for left, right in panorama_pairs:
        if left.master != left or right.master != left:
            malformed_groups.append(right.label)
        elif left.transform and right.transform:
            valid_pairs += 1
    pair_rate = valid_pairs / len(panorama_pairs) if panorama_pairs else 0.0
    alignment_rate = aligned / total if total else 0.0
    baselines = rig_baselines(chunk, panorama_pairs)
    tie_points = len(chunk.tie_points.points) if getattr(chunk, "tie_points", None) else 0
    reprojection = reprojection_error_statistics(chunk)

    trajectory_steps = []
    previous = None
    for left, _right in panorama_pairs:
        if not left.transform:
            continue
        center = chunk.transform.matrix.mulp(left.center)
        if previous is not None:
            delta = center - previous
            trajectory_steps.append(math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z))
        previous = center
    positive_steps = [step for step in trajectory_steps if step > 1e-9]
    median_step = statistics.median(positive_steps) if positive_steps else 0.0
    max_step_ratio = (max(positive_steps) / median_step) if median_step else 0.0

    calibration_issues = []
    for sensor in used_sensors(chunk):
        calib = sensor.calibration
        f = float(getattr(calib, "f", 0.0) or 0.0)
        size = min(int(sensor.width or 0), int(sensor.height or 0))
        if size > 0 and not (size * 0.05 < f < size * 2.0):
            calibration_issues.append(f"{sensor.label}: f={f:.3f}, size={sensor.width}x{sensor.height}")

    for profile, report in rig_reports.items():
        profile_pairs = [
            pair for pair in panorama_pairs
            if pair[0].sensor.label == f"{profile}_left"
        ]
        sensor_ok = bool(profile_pairs) and all(
            left.sensor.master == left.sensor
            and right.sensor.master == left.sensor
            and right.sensor.rotation is not None
            for left, right in profile_pairs
        )
        camera_ok = all(left.master == left and right.master == left for left, right in profile_pairs)
        report["post_optimize"] = {
            "native_sensor_relationship_ok": sensor_ok,
            "native_camera_relationship_ok": camera_ok,
            "p95_deviation_degrees": 0.0 if sensor_ok and camera_ok else 180.0,
        }

    failures = []
    if expected_total is not None and total != expected_total:
        failures.append(f"imported {total} cameras but manifest requires {expected_total}")
    if malformed_groups:
        failures.append(f"{len(malformed_groups)} panorama pairs lost their native master/slave relationship")
    if alignment_rate < 0.90:
        failures.append(f"overall camera alignment rate {alignment_rate:.1%} is below 90%")
    if pair_rate < 0.95:
        failures.append(f"complete panorama-pair alignment rate {pair_rate:.1%} is below 95%")
    if baselines and max(baselines) > 1e-5:
        failures.append(f"Rigid-rig baseline max {max(baselines):.8f} exceeds 1e-5")
    if any(report["p95_deviation_degrees"] > 1.5 for report in rig_reports.values()):
        failures.append("one or more rigid-rig calibrations have p95 rotation spread above 1.5 degrees")
    implausible_rig_angles = [
        f"{profile}: {report.get('rotation_angle_degrees', 0.0):.2f} degrees"
        for profile, report in rig_reports.items()
        if abs(report.get("rotation_angle_degrees", 0.0) - 180.0) > 15.0
    ]
    if implausible_rig_angles:
        failures.append(
            "dual-fisheye lenses are not approximately back-to-back: "
            + "; ".join(implausible_rig_angles)
        )
    if any(
        report.get("post_optimize", {}).get("p95_deviation_degrees", 0.0) > 0.05
        for report in rig_reports.values()
    ):
        failures.append("master/slave rig did not hold relative rotation within 0.05 degrees")
    if tie_points < max(100, total * 5):
        failures.append(f"only {tie_points} tie points for {total} cameras")
    if reprojection["count"] == 0:
        failures.append("no valid tie-point reprojection measurements")
    else:
        if reprojection["median_pixels"] > 3.0:
            failures.append(
                f"median reprojection error {reprojection['median_pixels']:.2f}px exceeds 3.0px"
            )
        if reprojection["p95_pixels"] > 15.0:
            failures.append(
                f"p95 reprojection error {reprojection['p95_pixels']:.2f}px exceeds 15.0px"
            )
    if calibration_issues:
        failures.append("implausible sensor calibration: " + "; ".join(calibration_issues[:4]))
    if max_step_ratio > 100.0:
        failures.append(f"trajectory has an extreme jump ({max_step_ratio:.1f}x median step)")

    return {
        "ok": not failures,
        "total_cameras": total,
        "expected_cameras": expected_total,
        "aligned_cameras": aligned,
        "alignment_rate": alignment_rate,
        "station_groups": len(panorama_pairs),
        "aligned_station_pairs": valid_pairs,
        "station_pair_rate": pair_rate,
        "station_baseline_max": max(baselines) if baselines else None,
        "tie_points": tie_points,
        "reprojection_error": reprojection,
        "trajectory_median_step": median_step,
        "trajectory_max_step_ratio": max_step_ratio,
        "rig_profiles": rig_reports,
        "failures": failures,
    }


def _run_align_phase(
    chunk,
    *,
    reset_alignment,
    prog_before_match,
    prog_after_align,
    prog_complete,
    keypoint_limit,
    tiepoint_limit,
):
    emit_progress(prog_before_match)
    chunk.matchPhotos(
        downscale=1,
        generic_preselection=True,
        reference_preselection=False,
        # The camera body/operator remains at nearly fixed image coordinates
        # in wearable dual-fisheye footage.  Keeping those tracks can make a
        # numerically clean alignment converge to a physically impossible rig
        # angle and corrupt the entire sparse cloud.
        filter_stationary_points=True,
        guided_matching=False,
        keypoint_limit=keypoint_limit,
        tiepoint_limit=tiepoint_limit,
        keep_keypoints=True,
    )
    emit_progress(prog_after_align)

    align_kwargs = {"adaptive_fitting": True}
    if not reset_alignment and _supports_reset_alignment():
        align_kwargs["reset_alignment"] = False
    chunk.alignCameras(**align_kwargs)

    chunk.optimizeCameras(fit_b1=False, fit_b2=False, fit_k4=False)
    emit_progress(prog_complete)


def write_alignment_summary(chunk, export_dir, panorama_pairs):
    aligned = [camera for camera in chunk.cameras if camera.transform]
    distances = rig_baselines(chunk, panorama_pairs)
    lines = [
        "xPano Metashape alignment summary",
        f"cameras={len(chunk.cameras)}",
        f"aligned={len(aligned)}",
        f"rig_pairs={len(panorama_pairs)}",
        f"sensors={len(used_sensors(chunk))}",
    ]
    if distances:
        lines.append(
            "rig_baseline_min_max_avg="
            f"{min(distances):.9f},{max(distances):.9f},{(sum(distances) / len(distances)):.9f}"
        )
    for sensor in used_sensors(chunk):
        calib = sensor.calibration
        lines.append(
            "sensor="
            f"{sensor.label},type={sensor.type},size={sensor.width}x{sensor.height},"
            f"pixel={sensor.pixel_width},{sensor.pixel_height},focal={sensor.focal_length},"
            f"calib_f={getattr(calib, 'f', None)},"
            f"cx={getattr(calib, 'cx', None)},cy={getattr(calib, 'cy', None)},"
            f"k1={getattr(calib, 'k1', None)},k2={getattr(calib, 'k2', None)},"
            f"k3={getattr(calib, 'k3', None)},k4={getattr(calib, 'k4', None)},"
            f"p1={getattr(calib, 'p1', None)},p2={getattr(calib, 'p2', None)},"
            f"fixed={list(sensor.fixed_params)}"
        )
    (export_dir / "workspace" / "alignment_summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    args = parse_args()
    export_dir = Path(args.export_dir)
    export_dir.mkdir(parents=True, exist_ok=True)
    workspace_dir = export_dir / "workspace"
    workspace_dir.mkdir(parents=True, exist_ok=True)
    project_path = workspace_dir / "xpano.psx"

    # Suppress the crash-recovery dialog that blocks headless mode.
    # Multiple known keys — different Metashape versions use different names.
    for key in ("main/recovery_prompt", "main/skip_recovery_dialog", "main/check_for_updates"):
        try:
            Metashape.app.settings.setValue(key, False)
        except Exception:
            pass
    configure_gpu_preference()

    doc = Metashape.app.document
    chunk = doc.addChunk()
    doc.chunk = chunk
    emit_progress(38)   # alignment has begun — prevent 0% stall
    emit_progress(40)
    manifest = load_manifest(args.manifest)
    track_types_in_manifest = {t.get("track_type") for t in manifest.get("tracks", [])}
    if "panorama_video" not in track_types_in_manifest:
        raise RuntimeError("Manifest must contain at least one panorama_video track")

    print(f"Metashape alignCameras supports reset_alignment: {_supports_reset_alignment()}", flush=True)

    # Phase 1: native Metashape multiplane import creates persistent camera and
    # sensor master/slave relationships before matching starts.
    sensor_cache = {}
    pano_pairs = import_manifest_tracks(
        chunk, manifest, track_types={"panorama_video"}, sensor_cache=sensor_cache
    )
    panorama_keypoint_limit = min(args.keypoint_limit, 10000)
    if panorama_keypoint_limit != args.keypoint_limit:
        print(
            f"Panorama keypoint limit capped at {panorama_keypoint_limit} "
            f"(requested {args.keypoint_limit}) to suppress unstable fisheye-edge matches",
            flush=True,
        )
    _run_align_phase(
        chunk,
        reset_alignment=True,
        prog_before_match=50, prog_after_align=63, prog_complete=72,
        keypoint_limit=panorama_keypoint_limit, tiepoint_limit=args.tiepoint_limit,
    )
    rig_reports = configure_rigid_rigs(chunk, pano_pairs, sensor_cache)

    # Phase 2: standard/aerial photos
    if track_types_in_manifest & {"standard_photos", "aerial_photos"}:
        before_total = len(chunk.cameras)
        before_aligned = len([c for c in chunk.cameras if c.transform])
        print(f"Phase 2 start: {before_total} total cameras, {before_aligned} aligned", flush=True)

        import_manifest_tracks(
            chunk,
            manifest,
            track_types={"standard_photos", "aerial_photos"},
            sensor_cache=sensor_cache,
        )
        after_import = len(chunk.cameras)
        print(f"After importing photos: {after_import} total cameras (+{after_import - before_total})", flush=True)

        _run_align_phase(
            chunk,
            # Standard/aerial photos remain independent Folder cameras. Native
            # multiplane relationships keep panorama pairs rigid.
            reset_alignment=False,
            prog_before_match=78, prog_after_align=84, prog_complete=90,
            keypoint_limit=args.keypoint_limit, tiepoint_limit=args.tiepoint_limit,
        )

        after_align = len([c for c in chunk.cameras if c.transform])
        print(f"Phase 2 done: {after_align}/{len(chunk.cameras)} cameras aligned (gained {after_align - before_aligned})", flush=True)
    else:
        emit_progress(90)

    write_alignment_summary(chunk, export_dir, pano_pairs)
    quality_report = evaluate_alignment_quality(chunk, pano_pairs, rig_reports, manifest=manifest)
    quality_path = workspace_dir / "alignment_quality_report.json"
    quality_path.write_text(
        json.dumps(quality_report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # Metashape's application document reloads itself on the first save(path).
    # Save only after all operations that use the current Python chunk proxy;
    # export_colmap then deliberately reads the reloaded app.document.chunk.
    doc.save(str(project_path))
    if not quality_report["ok"]:
        raise RuntimeError(
            "Alignment quality gate failed: " + "; ".join(quality_report["failures"])
            + f". Inspect {quality_path} and {project_path}"
        )
    emit_progress(96)

    emit_progress(97)

    print(">>> 导出 COLMAP/Cubemap", flush=True)
    export_colmap.run_mixed_export(str(export_dir))
    print(">>> COLMAP 文件已写入，正在进行最终地面后处理", flush=True)
    try:
        ground_result = apply_colmap_ground_alignment(
            export_dir / "sparse" / "0", up_axis=args.up_axis
        )
        (export_dir / "workspace" / "ground_alignment_summary.json").write_text(
            json.dumps(ground_result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(
            "COLMAP ground alignment: "
            f"{ground_result['angle_before_degrees']:.2f}° -> {ground_result['angle_after_degrees']:.2f}°",
            flush=True,
        )
    except Exception as exc:
        print(f"WARN: COLMAP 地面后处理校正失败，保留原导出: {exc}", flush=True)
    print(">>> 最终输出校验完成", flush=True)
    emit_progress(99)


if __name__ == "__main__":
    main()
