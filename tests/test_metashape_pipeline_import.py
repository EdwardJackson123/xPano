import sys
import tempfile
import types
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

if "Metashape" not in sys.modules:
    sys.modules["Metashape"] = types.SimpleNamespace()

from scripts.metashape_pipeline import add_photos_get_new


class FakePhoto:
    def __init__(self, path):
        self.path = str(path)


class FakeCamera:
    def __init__(self, key, path):
        self.key = key
        self.photo = FakePhoto(path)
        self.label = Path(path).name


class ReorderingChunk:
    def __init__(self, existing, new_insert_index):
        self.cameras = list(existing)
        self.new_insert_index = new_insert_index
        self.next_key = max((camera.key for camera in self.cameras), default=0) + 1

    def addPhotos(self, paths, **_kwargs):
        new_cameras = []
        for path in paths:
            new_cameras.append(FakeCamera(self.next_key, path))
            self.next_key += 1
        self.cameras[self.new_insert_index:self.new_insert_index] = new_cameras


class AddPhotosGetNewTests(unittest.TestCase):
    def test_returns_new_cameras_by_key_not_list_tail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pano_a = root / "pano_a.jpg"
            pano_b = root / "pano_b.jpg"
            phone_a = root / "phone_a.jpg"
            phone_b = root / "phone_b.jpg"
            for path in (pano_a, pano_b, phone_a, phone_b):
                path.write_bytes(b"x")

            existing = [FakeCamera(10, pano_a), FakeCamera(11, pano_b)]
            chunk = ReorderingChunk(existing, new_insert_index=0)

            imported = add_photos_get_new(chunk, [phone_a, phone_b], group_key=123)

            self.assertEqual([Path(camera.photo.path).name for camera in imported], ["phone_a.jpg", "phone_b.jpg"])
            self.assertEqual([camera.key for camera in imported], [12, 13])

    def test_rejects_unexpected_new_camera_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            expected = root / "phone.jpg"
            unexpected = root / "pano_tail.jpg"
            expected.write_bytes(b"x")
            unexpected.write_bytes(b"x")

            class WrongPathChunk(ReorderingChunk):
                def addPhotos(self, paths, **kwargs):
                    super().addPhotos([unexpected], **kwargs)

            chunk = WrongPathChunk([], new_insert_index=0)

            with self.assertRaisesRegex(RuntimeError, "unexpected cameras"):
                add_photos_get_new(chunk, [expected])


if __name__ == "__main__":
    unittest.main()
