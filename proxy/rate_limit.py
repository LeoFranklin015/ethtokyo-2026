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

    per_device = limits["per_device_per_day"]
    per_group = limits["group_per_day"]
    per_ens = limits["per_ens_per_day"]

    # Spec §6: device, group, and ENS are three INDEPENDENT quota knobs, each
    # enforced when configured. A request must clear EVERY configured cap before
    # any counter is incremented — so no scope's counter advances on a request
    # another scope blocks. We therefore check all configured caps first (no
    # writes), then increment all tracked counters once all pass.

    # Fail closed: a configured per-ENS cap must always apply. If the caller has
    # no ENS identity to key the shared bucket on, deny rather than grant.
    if per_ens is not None and not ens_name:
        return {"scope": "ens", "limit": per_ens, "used": per_ens,
                "resets_at": _resets_at(), "detail": "ens_identity_required"}

    # Read-only cap checks. Each returns a block dict if the scope is at/over its
    # effective limit (limit + adjustments), else None.
    if per_device is not None:
        eff = per_device + _get_adjustment(db, date, "device", ip, group_id, resource_id)
        used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_counters WHERE date=? AND ip=? AND resource_id=?",
            (date, ip, resource_id)
        ).fetchone() or {"c": 0})["c"]
        if used >= eff:
            return {"scope": "device", "limit": eff, "used": used,
                    "resets_at": _resets_at(), "top_up_available": True}

    if per_group is not None:
        eff = per_group + _get_adjustment(db, date, "group", ip, group_id, resource_id)
        used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_group_counters WHERE date=? AND group_id=? AND resource_id=?",
            (date, group_id, resource_id)
        ).fetchone() or {"c": 0})["c"]
        if used >= eff:
            return {"scope": "group", "limit": eff, "used": used,
                    "resets_at": _resets_at(), "top_up_available": True}

    if per_ens is not None:
        used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_ens_counters WHERE date=? AND ens_name=? AND resource_id=?",
            (date, ens_name, resource_id)
        ).fetchone() or {"c": 0})["c"]
        if used >= per_ens:
            return {"scope": "ens", "limit": per_ens, "used": used, "resets_at": _resets_at()}

    # All configured caps cleared — increment every counter once (device + group
    # always tracked; ENS tracked when the caller carries an ENS identity).
    _bump_device(db, date, ip, resource_id)
    _bump_group(db, date, group_id, resource_id)
    if ens_name:
        db.execute(
            "INSERT INTO daily_ens_counters(date,ens_name,resource_id,count) VALUES(?,?,?,1) "
            "ON CONFLICT(date,ens_name,resource_id) DO UPDATE SET count=count+1",
            (date, ens_name, resource_id)
        )
    db.commit()
    return None


def _bump_device(db, date, ip, resource_id):
    db.execute(
        "INSERT INTO daily_counters(date,ip,resource_id,count) VALUES(?,?,?,1) "
        "ON CONFLICT(date,ip,resource_id) DO UPDATE SET count=count+1",
        (date, ip, resource_id)
    )


def _bump_group(db, date, group_id, resource_id):
    db.execute(
        "INSERT INTO daily_group_counters(date,group_id,resource_id,count) VALUES(?,?,?,1) "
        "ON CONFLICT(date,group_id,resource_id) DO UPDATE SET count=count+1",
        (date, group_id, resource_id)
    )


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
