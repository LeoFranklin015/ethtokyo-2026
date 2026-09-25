import time
from datetime import datetime, timezone
from db import get_db


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _resets_at() -> str:
    """ISO timestamp of next UTC midnight."""
    now = datetime.now(timezone.utc)
    next_midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    from datetime import timedelta
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


def check_and_increment(ip: str, group_id: str, resource_id: str):
    """
    Check rate limits. Returns None if allowed.
    Returns error dict if blocked: {scope, limit, used, resets_at}.
    Does NOT increment on block.
    """
    db = get_db()
    date = _today()

    limits = db.execute(
        "SELECT per_device_per_day, group_per_day FROM group_resource_limits "
        "WHERE group_id=? AND resource_id=?",
        (group_id, resource_id)
    ).fetchone()

    # Row must exist (access grant check done in proxy.py before this call)
    if limits is None:
        return {"error": "no_access", "scope": "group", "limit": 0, "used": 0, "resets_at": _resets_at()}

    # Per-device check
    if limits["per_device_per_day"] is not None:
        device_used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_counters WHERE date=? AND ip=? AND resource_id=?",
            (date, ip, resource_id)
        ).fetchone() or {"c": 0})["c"]
        adj = _get_adjustment(db, date, "device", ip, group_id, resource_id)
        effective = limits["per_device_per_day"] + adj
        if device_used >= effective:
            return {
                "scope": "device", "limit": effective, "used": device_used,
                "resets_at": _resets_at(), "top_up_available": True
            }

    # Per-group check
    if limits["group_per_day"] is not None:
        group_used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_group_counters WHERE date=? AND group_id=? AND resource_id=?",
            (date, group_id, resource_id)
        ).fetchone() or {"c": 0})["c"]
        adj = _get_adjustment(db, date, "group", ip, group_id, resource_id)
        effective = limits["group_per_day"] + adj
        if group_used >= effective:
            return {
                "scope": "group", "limit": effective, "used": group_used,
                "resets_at": _resets_at(), "top_up_available": True
            }

    # Allowed — increment both counters
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


def get_usage_for_ip(ip: str, group_id: str) -> dict:
    """Return today's usage across all resources accessible to this group."""
    db = get_db()
    date = _today()

    grants = db.execute(
        "SELECT grl.resource_id, grl.per_device_per_day, grl.group_per_day, "
        "r.slug FROM group_resource_limits grl JOIN resources r ON r.id=grl.resource_id "
        "WHERE grl.group_id=? AND r.enabled=1",
        (group_id,)
    ).fetchall()

    result = {}
    for g in grants:
        rid = g["resource_id"]
        slug = g["slug"]

        device_used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_counters WHERE date=? AND ip=? AND resource_id=?",
            (date, ip, rid)
        ).fetchone() or {"c": 0})["c"]

        group_used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_group_counters WHERE date=? AND group_id=? AND resource_id=?",
            (date, group_id, rid)
        ).fetchone() or {"c": 0})["c"]

        result[slug] = {
            "used": device_used,
            "device_limit": g["per_device_per_day"],
            "group_limit": g["group_per_day"],
            "group_used": group_used,
            "resets_at": _resets_at(),
        }
    return result
