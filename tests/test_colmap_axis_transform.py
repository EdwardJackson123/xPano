import tempfile
import unittest
from pathlib import Path

from scripts.colmap_backend import (
    PINHOLE_MODEL_ID,
    apply_axis_flip,
    read_colmap_images,
    read_colmap_points3d,
    write_colmap_cameras,
    write_colmap_images,
    write_colmap_points3d,
    _qvec_to_rotmat,
)


def camera_center(image):
    rot = _qvec_to_rotmat(image["qvec"])
    t = image["tvec"]
    return tuple(-sum(rot[row][col] * t[row] for row in range(3)) for col in range(3))


class ColmapAxisTransformTests(unittest.TestCase):
    def test_axis_flip_updates_points_and_camera_centers(self):
        with tempfile.TemporaryDirectory() as tmp:
            sparse = Path(tmp)
            write_colmap_cameras(sparse / "cameras.bin", [{
                "id": 1,
                "model_id": PINHOLE_MODEL_ID,
                "width": 100,
                "height": 80,
                "params": (50.0, 50.0, 50.0, 40.0),
            }])
            write_colmap_images(sparse / "images.bin", [{
                "id": 1,
                "qvec": (1.0, 0.0, 0.0, 0.0),
                "tvec": (-1.0, -2.0, -3.0),
                "camera_id": 1,
                "name": "image.jpg",
                "points2d": [],
            }])
            write_colmap_points3d(sparse / "points3D.bin", [{
                "id": 1,
                "xyz": (4.0, 5.0, 6.0),
                "rgb": (255, 128, 0),
                "error": 0.25,
                "track": [],
            }])

            apply_axis_flip(sparse, "y")

            point = read_colmap_points3d(sparse)[0]
            image = read_colmap_images(sparse)[0]

            self.assertEqual(point["xyz"], (4.0, -5.0, -6.0))
            self.assertEqual(tuple(round(v, 6) for v in camera_center(image)), (1.0, -2.0, -3.0))


if __name__ == "__main__":
    unittest.main()
