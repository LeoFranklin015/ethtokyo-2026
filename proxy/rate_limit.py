import time
from datetime import datetime, timezone, timedelta
from db import get_db


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _resets_at() -> str:
    """ISO timestamp of next UTC midnight."""
    now = datetime.now(timezone.utc)
    next_midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    next_midnight += timedelta(days=1)
    return next_midnight.isoformat()


def _get_adjustment(db, date: str, scope: str, ip: str, group_id: str, resource_id: str) -> int:
    if scope == "device":
        rows = db.execute(
            "SELECT COALESCE(SUM(amount),0) as total FROM quota_adjustments "
            "WHERE date=? AND scope='device' AND ip=? AND resource_id=?",
            (date, ip, resource_id)
        ).fetchone()
    else:
        rows = db.execute(
            "SELECT COALESCE(SUM(amount),0) as total FROM quota_adjustments "
            "WHERE date=? AND scope='group' AND group_id=? AND resource_id=?",
            (date, group_id, resource_id)
        ).fetchone()
    return max(0, rows["total"])


def check_and_increment(ip: str, group_id: str, resource_id: str, ens_name=None):
    """
    Check rate limits. Returns None if allowed.
    Returns error dict if blocked: {scope, limit, used, resets_at}.
    Does NOT increment on block.
    """
    db = get_db()
    date = _today()

    limits = db.execute(
        "SELECT per_device_per_day, group_per_day, per_ens_per_day FROM group_resource_limits "
        "WHERE group_id=? AND resource_id=?",
        (group_id, resource_id)
    ).fetchone()

    # Row must exist (access grant check done in proxy.py before this call)
    if limits is None:
        return {"error": "no_access", "scope": "group", "limit": 0, "used": 0, "resets_at": _resets_at()}

    # Per-device check + atomic increment
    if limits["per_device_per_day"] is not None:
        adj = _get_adjustment(db, date, "device", ip, group_id, resource_id)
        effective = limits["per_device_per_day"] + adj
        # Atomic: increment only if below limit; returns new count or None if limit hit
        device_row = db.execute(
            """
            INSERT INTO daily_counters(date, ip, resource_id, count) VALUES (?, ?, ?, 1)
            ON CONFLICT(date, ip, resource_id) DO UPDATE SET count = count + 1
            WHERE count < ?
            RETURNING count
            """,
            (date, ip, resource_id, effective)
        ).fetchone()
        if device_row is None:
            # limit already hit, no increment happened — read current count for reporting
            device_used = (db.execute(
                "SELECT COALESCE(count,0) as c FROM daily_counters WHERE date=? AND ip=? AND resource_id=?",
                (date, ip, resource_id)
            ).fetchone() or {"c": 0})["c"]
            db.commit()
            return {
                "scope": "device", "limit": effective, "used": device_used,
                "resets_at": _resets_at(), "top_up_available": True
            }
        # Device increment succeeded; now increment group counter too
        db.execute(
            "INSERT INTO daily_group_counters(date,group_id,resource_id,count) VALUES(?,?,?,1) "
            "ON CONFLICT(date,group_id,resource_id) DO UPDATE SET count=count+1",
            (date, group_id, resource_id)
        )
        db.commit()
        return None

    # Per-group check + atomic increment (no device limit)
    if limits["group_per_day"] is not None:
        adj = _get_adjustment(db, date, "group", ip, group_id, resource_id)
        effective = limits["group_per_day"] + adj
        group_row = db.execute(
            """
            INSERT INTO daily_group_counters(date, group_id, resource_id, count) VALUES (?, ?, ?, 1)
            ON CONFLICT(date, group_id, resource_id) DO UPDATE SET count = count + 1
            WHERE count < ?
            RETURNING count
            """,
            (date, group_id, resource_id, effective)
        ).fetchone()
        if group_row is None:
            group_used = (db.execute(
                "SELECT COALESCE(count,0) as c FROM daily_group_counters WHERE date=? AND group_id=? AND resource_id=?",
                (date, group_id, resource_id)
            ).fetchone() or {"c": 0})["c"]
            db.commit()
            return {
                "scope": "group", "limit": effective, "used": group_used,
                "resets_at": _resets_at(), "top_up_available": True
            }
        # Group increment succeeded; also increment device counter for tracking
        db.execute(
            "INSERT INTO daily_counters(date,ip,resource_id,count) VALUES(?,?,?,1) "
            "ON CONFLICT(date,ip,resource_id) DO UPDATE SET count=count+1",
            (date, ip, resource_id)
        )
        db.commit()
        return None

    # Per-ENS-user shared bucket check + atomic increment (no device/group limit)
    per_ens = limits["per_ens_per_day"] if "per_ens_per_day" in limits.keys() else None
    if ens_name and per_ens is not None:
        ens_row = db.execute(
            "INSERT INTO daily_ens_counters(date,ens_name,resource_id,count) VALUES(?,?,?,1) "
            "ON CONFLICT(date,ens_name,resource_id) DO UPDATE SET count=count+1 "
            "WHERE count < ? RETURNING count",
            (date, ens_name, resource_id, per_ens)
        ).fetchone()
        if ens_row is None:
            ens_used = (db.execute(
                "SELECT COALESCE(count,0) as c FROM daily_ens_counters "
                "WHERE date=? AND ens_name=? AND resource_id=?",
                (date, ens_name, resource_id)
            ).fetchone() or {"c": 0})["c"]
            db.commit()
            return {"scope": "ens", "limit": per_ens, "used": ens_used, "resets_at": _resets_at()}
        # ENS increment succeeded; also track device + group counters
        db.execute(
            "INSERT INTO daily_counters(date,ip,resource_id,count) VALUES(?,?,?,1) "
            "ON CONFLICT(date,ip,resource_id) DO UPDATE SET count=count+1",
            (date, ip, resource_id)
        )
        db.execute(
            "INSERT INTO daily_group_counters(date,group_id,resource_id,count) VALUES(?,?,?,1) "
            "ON CONFLICT(date,group_id,resource_id) DO UPDATE SET count=count+1",
            (date, group_id, resource_id)
        )
        db.commit()
        return None

    # No limits configured — increment both counters for tracking only
    db.execute(
        "INSERT INTO daily_counters(date,ip,resource_id,count) VALUES(?,?,?,1) "
        "ON CONFLICT(date,ip,resource_id) DO UPDATE SET count=count+1",
        (date, ip, resource_id)
    )
    db.execute(
        "INSERT INTO daily_group_counters(date,group_id,resource_id,count) VALUES(?,?,?,1) "
        "ON CONFLICT(date,group_id,resource_id) DO UPDATE SET count=count+1",
        (date, group_id, resource_id)
    )
    db.commit()
    return None


def get_usage_for_ip(ip: str, group_id: str, ens_name: str = None) -> dict:
    """Return today's usage across all resources accessible to this group.

    When ens_name is given, also surface the per-ENS shared bucket
    (ens_limit + ens_used) — the quota shared across all of a user's devices.
    """
    db = get_db()
    today = datetime.now(timezone.utc).date().isoformat()
    rows = db.execute(
        """
        SELECT grl.resource_id, grl.per_device_per_day, grl.group_per_day,
               grl.per_ens_per_day,
               r.slug,
               COALESCE(dc.count, 0) AS device_used,
               COALESCE(dgc.count, 0) AS group_used,
               COALESCE(dec.count, 0) AS ens_used
        FROM group_resource_limits grl
        JOIN resources r ON r.id = grl.resource_id
        LEFT JOIN daily_counters dc
               ON dc.date = ? AND dc.ip = ? AND dc.resource_id = grl.resource_id
        LEFT JOIN daily_group_counters dgc
               ON dgc.date = ? AND dgc.group_id = grl.group_id
              AND dgc.resource_id = grl.resource_id
        LEFT JOIN daily_ens_counters dec
               ON dec.date = ? AND dec.ens_name = ?
              AND dec.resource_id = grl.resource_id
        WHERE grl.group_id = ? AND r.enabled = 1
        """,
        (today, ip, today, today, ens_name, group_id)
    ).fetchall()
    result = {}
    for r in rows:
        entry = {
            "used": r["device_used"],
            "device_limit": r["per_device_per_day"],
            "group_limit": r["group_per_day"],
            "group_used": r["group_used"],
            "resets_at": _resets_at(),
        }
        if ens_name is not None:
            entry["ens_limit"] = r["per_ens_per_day"]
            entry["ens_used"] = r["ens_used"]
        result[r["slug"]] = entry
    return result
