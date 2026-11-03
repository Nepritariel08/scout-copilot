"""Run only Scout's Odoo20 addon tests against the exclusive synthetic local target."""

import argparse
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--update", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve()
    expected = "bb238af6f0ddd70d7ff91521c6104472583661d1"
    observed = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if (
        observed != expected
        or subprocess.check_output(
            ["git", "-C", str(source), "status", "--porcelain"], text=True
        ).strip()
    ):
        raise SystemExit("Exact clean official Odoo20 source required")
    if (
        "qualification" not in args.data_dir.resolve().parts
        or args.data_dir.name != "odoo-data"
    ):
        raise SystemExit("Dedicated qualification/odoo-data path required")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(source))
    import odoo.cli

    addons = Path(__file__).resolve().parents[2]
    # Odoo's test framework starts an HTTP thread even with --no-http. Port0
    # binds a NEW loopback-only ephemeral socket, never the existing8069 server.
    sys.argv = [
        "odoo",
        "--db_host=127.0.0.1",
        "--db_port=25443",
        "--db_user=scout_workspace_test",
        "--database=scout_odoo_workspace_test_20261103",
        "--db-filter=^scout_odoo_workspace_test_20261103$",
        "--http-interface=127.0.0.1",
        "--http-port=0",
        "--no-http",
        "--no-database-list",
        "--stop-after-init",
        "--test-enable",
        "--test-tags=/scout_workspace",
        "--without-demo=true",
        "--max-cron-threads=0",
        "--data-dir=" + str(args.data_dir.resolve()),
        "--addons-path=" + str(source / "addons") + "," + str(addons),
        "--log-level=test",
        "-u" if args.update else "-i",
        "scout_workspace",
    ]
    odoo.cli.main()


if __name__ == "__main__":
    main()
