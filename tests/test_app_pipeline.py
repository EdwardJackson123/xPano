import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import Mock, patch

from app import JobConfig, MaterialTrack, MultiTrackJobConfig, material_tracks_to_job_config, run_metashape_pipeline, run_multi_track_pipeline


class FakeProcess:
    def __init__(self):
        self.stdout = ["PROGRESS:100\n"]

    def wait(self):
        return 0


class AppPipelineTests(unittest.TestCase):
    def test_metashape_pipeline_allows_panorama_only_manifest(self):
        source = Path("scripts/metashape_pipeline.py").read_text(encoding="utf-8")
        self.assertNotIn("Manifest must contain at least one standard_photos or aerial_photos track", source)
        self.assertIn('if track_types_in_manifest & {"standard_photos", "aerial_photos"}:', source)

    def test_material_tracks_build_multi_track_job_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pano = root / "a.osv"
            phone = root / "phone"
            drone = root / "drone"
            output = root / "out"
            pano.write_bytes(b"video")
            phone.mkdir()
            drone.mkdir()

            job = material_tracks_to_job_config(
                tracks=[
                    MaterialTrack(track_type="panorama_video", label="insta", paths=[pano]),
                    MaterialTrack(track_type="standard_photos", label="phone", paths=[phone]),
                    MaterialTrack(track_type="aerial_photos", label="mavic", paths=[drone]),
                ],
                output_dir=output,
                seconds_per_frame=1.0,
                max_frames=5,
                metashape_exe="metashape.exe",
            )

            self.assertEqual(job.panorama_videos, [{
                "path": pano.resolve(),
                "start": 0.0,
                "end": 0.0,
                "seconds_per_frame": 1.0,
                "max_frames": 5,
            }])
            self.assertEqual(job.standard_photo_tracks, [("phone", [phone.resolve()])])
            self.assertEqual(job.aerial_photo_tracks, [("mavic", [drone.resolve()])])
            self.assertEqual(job.output_dir, output.resolve())

    def test_material_tracks_reject_empty_track(self):
        with self.assertRaisesRegex(ValueError, "must contain at least one path"):
            material_tracks_to_job_config(
                tracks=[MaterialTrack(track_type="panorama_video", label="empty", paths=[])],
                output_dir=Path("out"),
                seconds_per_frame=1.0,
                max_frames=0,
                metashape_exe="metashape.exe",
            )

    def test_material_tracks_preserve_per_panorama_extract_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pano_a = root / "a.osv"
            pano_b = root / "b.osv"
            pano_a.write_bytes(b"video")
            pano_b.write_bytes(b"video")

            job = material_tracks_to_job_config(
                tracks=[
                    MaterialTrack(track_type="panorama_video", label="a", paths=[pano_a], seconds_per_frame=1.0, max_frames=10),
                    MaterialTrack(track_type="panorama_video", label="b", paths=[pano_b], seconds_per_frame=0.5, max_frames=4),
                ],
                output_dir=root / "out",
                seconds_per_frame=2.0,
                max_frames=0,
                metashape_exe="metashape.exe",
            )

            self.assertEqual(job.panorama_videos, [
                {"path": pano_a.resolve(), "start": 0.0, "end": 0.0, "seconds_per_frame": 1.0, "max_frames": 10},
                {"path": pano_b.resolve(), "start": 0.0, "end": 0.0, "seconds_per_frame": 0.5, "max_frames": 4},
            ])

    def test_single_video_gui_pipeline_uses_manifest_backend(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            manifest_path = output / "workspace" / "xpano_manifest.json"
            manifest_path.parent.mkdir(parents=True)
            manifest_path.write_text("{}", encoding="utf-8")
            video = output / "input.osv"
            video.write_bytes(b"video")
            job = JobConfig(
                input_video=video,
                output_dir=output,
                seconds_per_frame=1.0,
                max_frames=10,
                metashape_exe="metashape.exe",
            )

            popen_calls = []

            def fake_popen(cmd, **kwargs):
                popen_calls.append(cmd)
                return FakeProcess()

            with patch("app.build_manifest", return_value=({}, manifest_path)) as build_manifest, \
                patch("app.subprocess.Popen", side_effect=fake_popen), \
                patch("app.write_run_summary"):
                run_metashape_pipeline(job, Mock(), Mock(), Mock())

            build_manifest.assert_called_once()
            self.assertIn("log_cb", build_manifest.call_args.kwargs)
            command = popen_calls[0]
            self.assertIn("--manifest", command)
            self.assertIn(str(manifest_path), command)
            self.assertNotIn("--input-root", command)

    def test_multi_track_pipeline_passes_all_track_types_to_manifest_backend(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            manifest_path = output / "workspace" / "xpano_manifest.json"
            manifest_path.parent.mkdir(parents=True)
            manifest_path.write_text("{}", encoding="utf-8")
            pano_a = output / "a.osv"
            pano_b = output / "b.insv"
            phone_dir = output / "phone"
            drone_dir = output / "drone"
            for path in [pano_a, pano_b]:
                path.write_bytes(b"video")
            phone_dir.mkdir()
            drone_dir.mkdir()
            job = MultiTrackJobConfig(
                panorama_videos=[pano_a, pano_b],
                standard_photo_tracks=[("phone", [phone_dir])],
                aerial_photo_tracks=[("mavic", [drone_dir])],
                output_dir=output,
                seconds_per_frame=1.0,
                max_frames=5,
                metashape_exe="metashape.exe",
            )

            popen_calls = []

            def fake_popen(cmd, **kwargs):
                popen_calls.append(cmd)
                return FakeProcess()

            with patch("app.build_manifest", return_value=({}, manifest_path)) as build_manifest, \
                patch("app.subprocess.Popen", side_effect=fake_popen), \
                patch("app.write_run_summary"):
                run_multi_track_pipeline(job, Mock(), Mock(), Mock())

            kwargs = build_manifest.call_args.kwargs
            self.assertEqual(kwargs["panorama_videos"], [pano_a, pano_b])
            self.assertEqual(kwargs["standard_photo_tracks"], [("phone", [phone_dir])])
            self.assertEqual(kwargs["aerial_photo_tracks"], [("mavic", [drone_dir])])
            self.assertIn("log_cb", kwargs)
            command = popen_calls[0]
            self.assertIn("--manifest", command)
            self.assertIn(str(manifest_path), command)

    def test_multi_track_pipeline_reuses_matching_extract_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            video = output / "a.osv"
            video.write_bytes(b"video")
            frames = output / "workspace" / "frames" / "track_001_a"
            frames.mkdir(parents=True)
            left = frames / "frame_000001_left.jpg"
            right = frames / "frame_000001_right.jpg"
            left.write_bytes(b"left")
            right.write_bytes(b"right")
            manifest_path = output / "workspace" / "xpano_manifest.json"
            manifest_path.write_text(json.dumps({
                "schema_version": 1,
                "workflow": "xpano_multi_track",
                "tracks": [{
                    "track_id": "track_001_a",
                    "track_type": "panorama_video",
                    "source_paths": [str(video.resolve())],
                    "seconds_per_frame": 1.0,
                    "max_frames": 5,
                    "start_time": 0.0,
                    "end_time": 0.0,
                    "metashape_mode": "dual_fisheye_station",
                    "export_mode": "cubemap",
                    "left_sensor_label": "track_001_a_left",
                    "right_sensor_label": "track_001_a_right",
                    "frames": [{
                        "frame_id": "frame_000001",
                        "group_label": "frame_000001",
                        "left": str(left),
                        "right": str(right),
                    }],
                }],
            }), encoding="utf-8")
            job = MultiTrackJobConfig(
                panorama_videos=[{"path": video.resolve(), "start": 0.0, "end": 0.0, "seconds_per_frame": 1.0, "max_frames": 5}],
                standard_photo_tracks=[],
                aerial_photo_tracks=[],
                output_dir=output,
                seconds_per_frame=1.0,
                max_frames=5,
                metashape_exe="metashape.exe",
            )

            popen_calls = []

            def fake_popen(cmd, **kwargs):
                popen_calls.append(cmd)
                return FakeProcess()

            with patch("app.build_manifest") as build_manifest, \
                patch("app.subprocess.Popen", side_effect=fake_popen), \
                patch("app.write_run_summary"):
                run_multi_track_pipeline(job, Mock(), Mock(), Mock())

            build_manifest.assert_not_called()
            self.assertTrue(left.exists())
            self.assertTrue(right.exists())
            self.assertIn(str(manifest_path.resolve()), popen_calls[0])

    def test_multi_track_pipeline_reextracts_when_cache_trim_mismatches(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            video = output / "a.osv"
            video.write_bytes(b"video")
            frames = output / "workspace" / "frames" / "track_001_a"
            frames.mkdir(parents=True)
            left = frames / "frame_000001_left.jpg"
            right = frames / "frame_000001_right.jpg"
            left.write_bytes(b"left")
            right.write_bytes(b"right")
            manifest_path = output / "workspace" / "xpano_manifest.json"
            manifest_path.write_text(json.dumps({
                "schema_version": 1,
                "workflow": "xpano_multi_track",
                "tracks": [{
                    "track_id": "track_001_a",
                    "track_type": "panorama_video",
                    "source_paths": [str(video.resolve())],
                    "seconds_per_frame": 1.0,
                    "max_frames": 5,
                    "start_time": 0.0,
                    "end_time": 0.0,
                    "metashape_mode": "dual_fisheye_station",
                    "export_mode": "cubemap",
                    "left_sensor_label": "track_001_a_left",
                    "right_sensor_label": "track_001_a_right",
                    "frames": [{
                        "frame_id": "frame_000001",
                        "group_label": "frame_000001",
                        "left": str(left),
                        "right": str(right),
                    }],
                }],
            }), encoding="utf-8")
            fresh_manifest = output / "workspace" / "xpano_manifest.json"
            job = MultiTrackJobConfig(
                panorama_videos=[{"path": video.resolve(), "start": 2.0, "end": 0.0, "seconds_per_frame": 1.0, "max_frames": 5}],
                standard_photo_tracks=[],
                aerial_photo_tracks=[],
                output_dir=output,
                seconds_per_frame=1.0,
                max_frames=5,
                metashape_exe="metashape.exe",
            )

            def fake_popen(cmd, **kwargs):
                return FakeProcess()

            with patch("app.build_manifest", return_value=({}, fresh_manifest)) as build_manifest, \
                patch("app.subprocess.Popen", side_effect=fake_popen), \
                patch("app.write_run_summary"):
                run_multi_track_pipeline(job, Mock(), Mock(), Mock())

            build_manifest.assert_called_once()


if __name__ == "__main__":
    unittest.main()
