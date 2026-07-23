# -*- coding: utf-8 -*-
"""Interactive entry point for the canonical xPano COLMAP exporter.

Keep the implementation in export_colmap.py so GUI, command-line re-export,
and this Metashape script always use the same camera and Cubemap model.
"""

from export_colmap import run_mixed_export


if __name__ == "__main__":
    run_mixed_export()
