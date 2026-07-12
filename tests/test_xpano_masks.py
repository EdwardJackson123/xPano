import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "xpano_masks.py"
SPEC = importlib.util.spec_from_file_location("xpano_masks", SCRIPT)
MASKS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MASKS)


class XpanoMasksTests(unittest.TestCase):
    def test_target_normalization_and_aliases(self):
        self.assertEqual(MASKS.normalize_targets("person, car, person"), ["person", "car"])
        self.assertEqual(MASKS.normalize_targets("motorbike;cellphone"), ["motorcycle", "cell phone"])

    def test_unknown_target_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "不支持的遮罩类别"):
            MASKS.normalize_targets("person, definitely-not-coco")

    def test_collect_images_is_non_recursive_and_stable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "b.JPG").touch()
            (root / "a.png").touch()
            (root / "notes.txt").touch()
            (root / "nested").mkdir()
            (root / "nested" / "ignored.jpg").touch()
            self.assertEqual([path.name for path in MASKS.collect_images(root)], ["a.png", "b.JPG"])

    def test_staging_is_separate_from_published_masks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            masks = root / "masks"
            masks.mkdir()
            (masks / "old.png").write_bytes(b"old")
            staging = MASKS.prepare_staging(root)
            (staging / "new.png").write_bytes(b"new")
            MASKS.publish_masks(staging, masks)
            self.assertFalse((masks / "old.png").exists())
            self.assertEqual((masks / "new.png").read_bytes(), b"new")


if __name__ == "__main__":
    unittest.main()
