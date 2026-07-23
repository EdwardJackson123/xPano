import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

if "Metashape" not in sys.modules:
    sys.modules["Metashape"] = types.SimpleNamespace()

import export_colmap
import metashape_pipeline


class FakeGroupType:
    Folder = "folder"
    Station = "station"


class FakeChunk:
    def __init__(self):
        self.events = []
        self.match_kwargs = None

    def matchPhotos(self, **kwargs):
        self.events.append("match")
        self.match_kwargs = kwargs

    def alignCameras(self, **_kwargs):
        self.events.append("align")

    def optimizeCameras(self, **_kwargs):
        self.events.append("optimize")


class NativeRigTests(unittest.TestCase):
    def test_alignment_does_not_replace_native_rig_with_station_groups(self):
        chunk = FakeChunk()
        with patch.object(metashape_pipeline, "emit_progress"):
            metashape_pipeline._run_align_phase(
                chunk,
                reset_alignment=True,
                prog_before_match=1,
                prog_after_align=2,
                prog_complete=3,
                keypoint_limit=100,
                tiepoint_limit=0,
            )

        self.assertEqual(chunk.events, ["match", "align", "optimize"])
        self.assertTrue(chunk.match_kwargs["filter_stationary_points"])

    def test_pipeline_saves_project_gates_quality_and_aligns_ground_once(self):
        source = (SCRIPTS_DIR / "metashape_pipeline.py").read_text(encoding="utf-8")
        self.assertIn('project_path = workspace_dir / "xpano.psx"', source)
        self.assertIn("layout=Metashape.MultiplaneLayout", source)
        self.assertIn("configure_rigid_rigs(chunk, pano_pairs, sensor_cache)", source)
        self.assertNotIn("stabilize_fisheye_intrinsics", source)
        self.assertIn("reprojection_error_statistics(chunk)", source)
        self.assertIn('"rotation_angle_degrees"', source)
        self.assertIn("dual-fisheye lenses are not approximately back-to-back", source)
        self.assertIn("evaluate_alignment_quality(chunk, pano_pairs, rig_reports, manifest=manifest)", source)
        self.assertNotIn("right_camera.master = left_camera", source)
        self.assertNotIn("align_ground_plane.main", source)
        self.assertEqual(source.count("apply_colmap_ground_alignment("), 1)
        self.assertIn("up_axis=args.up_axis", source)


class FakeCalibration:
    pass


class CubemapCalibrationTests(unittest.TestCase):
    def test_target_calibrations_match_colmap_principal_points(self):
        fake_metashape = types.SimpleNamespace(
            Calibration=FakeCalibration,
            Sensor=types.SimpleNamespace(Type=types.SimpleNamespace(Frame="frame")),
        )

        with patch.object(export_colmap, "Metashape", fake_metashape):
            for face in ("front", "left", "right", "top", "bottom"):
                calib = export_colmap.build_cubemap_calibration(face, 1000)
                width, height, expected_x, expected_y = export_colmap.get_face_configs(1000)[face]
                self.assertEqual((calib.width, calib.height), (width, height))
                self.assertEqual((width, height), (1000, 1000))
                self.assertEqual(calib.f, 500.0)
                self.assertEqual((expected_x, expected_y), (500, 500))
                self.assertEqual(calib.cx + width / 2.0, expected_x)
                self.assertEqual(calib.cy + height / 2.0, expected_y)

    def test_exporter_uses_native_warp_not_manual_opencv_remap(self):
        source = (SCRIPTS_DIR / "export_colmap.py").read_text(encoding="utf-8")
        self.assertIn("source_image.warp(", source)
        self.assertNotIn("cv2.remap", source)
        self.assertNotIn("def build_remap_grid", source)


if __name__ == "__main__":
    unittest.main()
