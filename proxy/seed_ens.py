import os, time, uuid

# (group name = on-chain wifi.group value, network_tier = portal-known tier).
# Portal tiers (portal/app.py TIER_MARK): basic, staff, vip, partner, hacker.
# Every on-chain wifi.group must have a row here or /internal/ens-lookup returns unknown_group.
GROUPS = [
    ("hacker", "hacker"),
    ("partner", "partner"),
    ("staff", "staff"),
    ("vip", "vip"),
    ("basic", "basic"),
]
USERS = [
    ("bob.doco.eth", "hacker"), ("alice.eth", "hacker"),
    ("world.eth", "partner"), ("soy.eth", "partner"), ("uniswap.eth", "partner"),
]


def _get_or_create_group(db, name, tier):
    row = db.execute("SELECT id, network_tier FROM groups WHERE name=?", (name,)).fetchone()
    if row:
        if row[1] != tier:
            db.execute("UPDATE groups SET network_tier=? WHERE id=?", (tier, row[0]))
        return row[0]
    gid = str(uuid.uuid4())
    db.execute("INSERT INTO groups(id,name,network_tier,notes,created_at) VALUES(?,?,?,?,?)",
               (gid, name, tier, "seeded", int(time.time())))
    return gid


def _get_or_create_user(db, ens, gid):
    row = db.execute("SELECT id FROM users WHERE username=?", (ens,)).fetchone()
    if row:
        db.execute("UPDATE users SET default_group_id=?, ens_name=? WHERE id=?", (gid, ens, row[0]))
        return row[0]
    uid = str(uuid.uuid4())
    db.execute("INSERT INTO users(id,username,password_hash,default_group_id,ens_name,created_at) "
               "VALUES(?,?,?,?,?,?)", (uid, ens, "", gid, ens, int(time.time())))
    return uid


def _get_or_create_alchemy(db):
    row = db.execute("SELECT id FROM resources WHERE slug='alchemy'").fetchone()
    if row:
        return row[0]
    rid = str(uuid.uuid4())
    db.execute(
        "INSERT INTO resources(id,slug,display_name,upstream_url,key_placement,api_key,enabled,created_at) "
        "VALUES(?,?,?,?,?,?,1,?)",
        (rid, "alchemy", "Alchemy Mainnet", "https://eth-mainnet.g.alchemy.com/v2",
         "url_path", os.environ.get("ALCHEMY_KEY", ""), int(time.time())))
    return rid


def seed(db):
    gids = {tier: _get_or_create_group(db, name, tier) for name, tier in GROUPS}
    for ens, tier in USERS:
        _get_or_create_user(db, ens, gids[tier])
    alchemy = _get_or_create_alchemy(db)
    # hacker gets Alchemy; partner explicitly does NOT
    db.execute(
        "INSERT OR IGNORE INTO group_resource_limits"
        "(group_id,resource_id,per_device_per_day,group_per_day,per_ens_per_day) "
        "VALUES(?,?,NULL,NULL,1000)", (gids["hacker"], alchemy))
    db.commit()


if __name__ == "__main__":
    import sqlite3
    import db as dbmod
    dbmod.init_db()
    con = sqlite3.connect(dbmod.DB_PATH)
    seed(con)
    print("seeded")
