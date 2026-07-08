import argparse
import inspect
import json
import math
import sys
from pathlib import Path

import Metashape

import align_ground_plane
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
    sensor.pixel_width = 0.0024
    sensor.pixel_height = 0.0024
    sensor.focal_length = 2.5
    sensor.fixed_params = ["B1", "B2", "K4"]
    calib = sensor.calibration
    if calib:
        calib.b1 = 0
        calib.b2 = 0
        calib.k4 = 0
        calib.type = Metashape.Sensor.Type.EquidistantFisheye


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

def import_panorama_track(chunk, track):
    station_groups = []
    left_sensor = None
    right_sensor = None
    left_label = track.get("left_sensor_label", f"{track['track_id']}_left")
    right_label = track.get("right_sensor_label", f"{track['track_id']}_right")

    for frame in track.get("frames", []):
        group = chunk.addCameraGroup()
        group.label = frame.get("group_label", frame.get("frame_id", track["track_id"]))
        group.type = Metashape.CameraGroup.Type.Folder
        station_groups.append(group)

        paths = [frame["left"], frame["right"]]
        new_cameras = add_photos_get_new(chunk, paths, group_key=group.key)
        for camera in new_cameras:
            name = camera_path_name(camera)
            if name == Path(frame["left"]).name.lower() or name.endswith("_left.jpg"):
                if left_sensor is None:
                    left_sensor = make_track_sensor(chunk, camera, left_label, Metashape.Sensor.Type.EquidistantFisheye)
                camera.sensor = left_sensor
            elif name == Path(frame["right"]).name.lower() or name.endswith("_right.jpg"):
                if right_sensor is None:
                    right_sensor = make_track_sensor(chunk, camera, right_label, Metashape.Sensor.Type.EquidistantFisheye)
                camera.sensor = right_sensor

    return station_groups


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


def import_manifest_tracks(chunk, manifest, track_types=None):
    station_groups = []
    for track in manifest.get("tracks", []):
        track_type = track.get("track_type")
        if track_types is not None and track_type not in track_types:
            continue
        if track_type == "panorama_video":
            station_groups.extend(import_panorama_track(chunk, track))
        elif track_type in {"standard_photos", "aerial_photos"}:
            import_photo_track(chunk, track)
        else:
            raise RuntimeError(f"Unsupported track_type: {track_type}")
    prune_unused_sensors(chunk)
    return station_groups


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


def station_distances(chunk):
    distances = []
    for group in chunk.camera_groups:
        cameras = [camera for camera in chunk.cameras if camera.group == group and camera.transform]
        if len(cameras) != 2:
            continue
        centers = [chunk.transform.matrix.mulp(camera.center) for camera in cameras]
        delta = centers[0] - centers[1]
        distances.append(math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z))
    return distances


def _run_align_phase(
    chunk,
    groups,
    *,
    use_station_mode,
    reset_alignment,
    prog_before_match,
    prog_after_align,
    prog_complete,
    keypoint_limit,
    tiepoint_limit,
):
    if use_station_mode:
        for group in groups:
            group.type = Metashape.CameraGroup.Type.Station

    emit_progress(prog_before_match)
    chunk.matchPhotos(
        downscale=1,
        generic_preselection=True,
        reference_preselection=False,
        filter_stationary_points=False,
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

    if use_station_mode:
        for group in groups:
            try:
                group.type = Metashape.CameraGroup.Type.Folder
            except Exception:
                pass

    chunk.optimizeCameras(fit_b1=False, fit_b2=False, fit_k4=False)
    emit_progress(prog_complete)


def write_alignment_summary(chunk, export_dir):
    aligned = [camera for camera in chunk.cameras if camera.transform]
    distances = station_distances(chunk)
    lines = [
        "xPano Metashape alignment summary",
        f"cameras={len(chunk.cameras)}",
        f"aligned={len(aligned)}",
        f"groups={len(chunk.camera_groups)}",
        f"sensors={len(used_sensors(chunk))}",
    ]
    if distances:
        lines.append(
            "station_baseline_min_max_avg="
            f"{min(distances):.9f},{max(distances):.9f},{(sum(distances) / len(distances)):.9f}"
        )
    for sensor in used_sensors(chunk):
        calib = sensor.calibration
        lines.append(
            "sensor="
            f"{sensor.label},type={sensor.type},size={sensor.width}x{sensor.height},"
            f"pixel={sensor.pixel_width},{sensor.pixel_height},focal={sensor.focal_length},"
            f"calib_f={getattr(calib, 'f', None)},fixed={list(sensor.fixed_params)}"
        )
    (export_dir / "workspace" / "alignment_summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    args = parse_args()
    export_dir = Path(args.export_dir)
    export_dir.mkdir(parents=True, exist_ok=True)

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

    # Phase 1: panorama only with station grouping
    pano_groups = import_manifest_tracks(chunk, manifest, track_types={"panorama_video"})
    _run_align_phase(
        chunk, pano_groups,
        use_station_mode=True, reset_alignment=True,
        prog_before_match=50, prog_after_align=63, prog_complete=72,
        keypoint_limit=args.keypoint_limit, tiepoint_limit=args.tiepoint_limit,
    )

    # Phase 2: standard/aerial photos
    if track_types_in_manifest & {"standard_photos", "aerial_photos"}:
        before_total = len(chunk.cameras)
        before_aligned = len([c for c in chunk.cameras if c.transform])
        print(f"Phase 2 start: {before_total} total cameras, {before_aligned} aligned", flush=True)

        import_manifest_tracks(chunk, manifest, track_types={"standard_photos", "aerial_photos"})
        after_import = len(chunk.cameras)
        print(f"After importing photos: {after_import} total cameras (+{after_import - before_total})", flush=True)

        _run_align_phase(
            chunk, [],
            use_station_mode=False, reset_alignment=False,
            prog_before_match=78, prog_after_align=84, prog_complete=90,
            keypoint_limit=args.keypoint_limit, tiepoint_limit=args.tiepoint_limit,
        )

        after_align = len([c for c in chunk.cameras if c.transform])
        print(f"Phase 2 done: {after_align}/{len(chunk.cameras)} cameras aligned (gained {after_align - before_aligned})", flush=True)
    else:
        emit_progress(90)

    write_alignment_summary(chunk, export_dir)
    emit_progress(96)

    print(">>> 自动地平面校正", flush=True)
    try:
        align_ground_plane.main(up_axis=args.up_axis)
    except Exception as exc:
        print(f"WARN: 地平面校正失败，继续导出: {exc}", flush=True)
    emit_progress(97)

    print(">>> 导出 COLMAP/Cubemap", flush=True)
    export_colmap.run_mixed_export(str(export_dir))
    print(">>> COLMAP 文件已写入，正在进行最终地面后处理", flush=True)
    try:
        ground_result = apply_colmap_ground_alignment(export_dir / "sparse" / "0")
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
