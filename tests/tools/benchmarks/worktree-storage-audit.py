#!/usr/bin/env python3
"""Read-only storage audit; APFS private bytes exclude blocks shared with other files."""

import argparse
import collections
import ctypes
import json
import os
import stat
import sys
import time


class AttributeList(ctypes.Structure):
    _fields_ = [
        ("count", ctypes.c_uint16),
        ("reserved", ctypes.c_uint16),
        ("common", ctypes.c_uint32),
        ("volume", ctypes.c_uint32),
        ("directory", ctypes.c_uint32),
        ("file", ctypes.c_uint32),
        ("extended", ctypes.c_uint32),
    ]


def apfs_private_reader(enabled):
    if not enabled or sys.platform != "darwin":
        return None
    library = ctypes.CDLL(None, use_errno=True)
    attributes = AttributeList(5, 0, 0, 0, 0, 0, 0x8)
    buffer = ctypes.create_string_buffer(32)

    def read(path):
        # ATTR_CMNEXT_PRIVATESIZE with FSOPT_ATTR_CMN_EXTENDED; payload follows length.
        result = library.getattrlist(os.fsencode(path), ctypes.byref(attributes), buffer, 32, 0x20)
        return None if result else int.from_bytes(buffer.raw[4:12], "little")

    return read


def audit(root, private_reader):
    groups = collections.defaultdict(collections.Counter)
    seen = set()
    errors = []
    stack = [(root, ".")]
    while stack:
        path, group = stack.pop()
        try:
            info = os.lstat(path)
            row = groups[group]
            if stat.S_ISLNK(info.st_mode):
                row["symlinks"] += 1
                continue
            if stat.S_ISDIR(info.st_mode):
                row["directories"] += 1
                with os.scandir(path) as entries:
                    for entry in entries:
                        stack.append((entry.path, entry.name if path == root else group))
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            row["files"] += 1
            row["logical_bytes"] += info.st_size
            allocated = getattr(info, "st_blocks", None)
            if allocated is not None:
                row["allocated_bytes_by_path"] += allocated * 512
            inode = (info.st_dev, info.st_ino)
            if inode in seen:
                row["duplicate_hardlink_paths"] += 1
                continue
            seen.add(inode)
            if allocated is not None:
                row["allocated_bytes_unique_inodes"] += allocated * 512
            if private_reader:
                private = private_reader(path)
                if private is None:
                    row["private_size_unavailable_files"] += 1
                else:
                    row["apfs_private_bytes"] += private
                    row["private_size_measured_files"] += 1
        except OSError as error:
            if len(errors) < 20:
                errors.append({"path": path, "error": str(error)})
            groups[group]["scan_errors"] += 1
    totals = collections.Counter()
    for group in groups.values():
        totals.update(group)
    return {"root": root, "totals": dict(totals), "top_level": dict(groups), "errors": errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", nargs="+", help="Directories to audit without following symlinks")
    parser.add_argument("--apfs-private", action="store_true", help="Query private allocation on macOS")
    args = parser.parse_args()
    start = time.monotonic()
    reader = apfs_private_reader(args.apfs_private)
    result = {
        "schema_version": 1,
        "platform": sys.platform,
        "apfs_private_requested": args.apfs_private,
        "apfs_private_supported_platform": reader is not None,
        "notes": [
            "No symlinks are followed; a linked dependency install is counted at its owning path.",
            "Allocated bytes count APFS/reflink shared blocks again; they are not deletion savings.",
            "APFS private bytes exclude shared blocks, including ones shared only within the audited roots.",
            "Unique inodes deduplicate hardlinks within each root; roots are measured independently.",
            "A live filesystem scan is not an atomic snapshot; inspect errors and unavailable counts.",
        ],
        "roots": [audit(os.path.abspath(root), reader) for root in args.roots],
        "elapsed_seconds": round(time.monotonic() - start, 3),
    }
    print(json.dumps(result, indent=2))
    return 1 if any(root["totals"].get("scan_errors") for root in result["roots"]) else 0


if __name__ == "__main__":
    sys.exit(main())
