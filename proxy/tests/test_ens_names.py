import os, tempfile, sqlite3, time, bcrypt
import db as dbmod


def _client(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db"); os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    import proxy
    proxy.app.config["TESTING"] = True
    return proxy.app.test_client(), path


def _auth(path):
    tok = "test-admin-token"
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO admin_tokens(id,name,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
        ("t-1", "test", bcrypt.hashpw(tok.encode(), bcrypt.gensalt()).decode(), int(time.time()), None))
    con.commit()
    return f"Bearer {tok}"


def _post(c, auth, **body):
    return c.post("/admin/ens-names", json=body, headers={"Authorization": auth})


def test_a_recorded_name_is_split_into_its_own_columns(monkeypatch):
    """The reader filters candidates by organization and by branch, so those columns must come
    from the name itself rather than from whatever the caller said they were."""
    c, path = _client(monkeypatch); auth = _auth(path)

    row = _post(c, auth, name="nyhvb.tokyo.test1243.eth", kind="membership",
                owner="0x1A4CB37AFFED4A3BD060EAAE5016FFCE4B632509").get_json()
    assert row["org"] == "test1243"
    assert row["branch_label"] == "tokyo"
    assert row["label"] == "nyhvb"
    # Wallets are compared against chain reads downstream, which are lowercase.
    assert row["owner"] == "0x1a4cb37affed4a3bd060eaae5016ffce4b632509"


def test_recording_the_same_name_twice_is_one_row(monkeypatch):
    """The console re-records a name every time it re-mirrors one — an onboarding retry, or the
    same member mirrored from two tabs — and a second row would mean the same candidate is
    verified and listed twice."""
    c, path = _client(monkeypatch); auth = _auth(path)

    first = _post(c, auth, name="nyhvb.tokyo.test1243.eth", kind="membership",
                  owner="0x1a4cb37affed4a3bd060eaae5016ffce4b632509").get_json()
    second = _post(c, auth, name="nyhvb.tokyo.test1243.eth", kind="membership",
                   registrar="0xfd5ec7886c81e80830e3c06e7401b3bf8a88e573").get_json()

    assert second["created_at"] == first["created_at"]
    # The second call knew the registrar and not the owner; neither fact should be lost.
    assert second["owner"] == first["owner"]
    assert second["registrar"] == "0xfd5ec7886c81e80830e3c06e7401b3bf8a88e573"

    listed = c.get("/admin/ens-names?org=test1243", headers={"Authorization": auth}).get_json()
    assert listed["total"] == 1


def test_candidates_are_listed_per_organization_branch_and_kind(monkeypatch):
    """One enforcer serves every organization pointed at it, so an unfiltered candidate list
    would offer another organization's names for verification — and a branch filter that did not
    bite would resurrect the bug where asking for Osaka returned Tokyo's members."""
    c, path = _client(monkeypatch); auth = _auth(path)

    _post(c, auth, name="test1243.eth", kind="organization")
    _post(c, auth, name="tokyo.test1243.eth", kind="branch")
    _post(c, auth, name="nyhvb.tokyo.test1243.eth", kind="membership")
    _post(c, auth, name="ada.osaka.test1243.eth", kind="membership")
    _post(c, auth, name="bob.tokyo.other.eth", kind="membership")

    def names(query):
        body = c.get(f"/admin/ens-names?{query}", headers={"Authorization": auth}).get_json()
        return {n["name"] for n in body["names"]}

    assert names("org=test1243&kind=membership") == {
        "nyhvb.tokyo.test1243.eth", "ada.osaka.test1243.eth"}
    assert names("org=test1243&kind=membership&branch=tokyo") == {"nyhvb.tokyo.test1243.eth"}
    assert names("org=test1243&kind=branch") == {"tokyo.test1243.eth"}
    assert names("org=other") == {"bob.tokyo.other.eth"}
    # A suffix match would be wrong here as it is for users: `other` is not `test1243`.
    assert names("org=test1243") == {
        "test1243.eth", "tokyo.test1243.eth", "nyhvb.tokyo.test1243.eth", "ada.osaka.test1243.eth"}


def test_a_name_that_does_not_match_its_kind_is_refused(monkeypatch):
    """A membership row is a name three labels deep. Anything else stored as one would be handed
    to the verifier as a branch or an organization and could only produce a wrong answer."""
    c, path = _client(monkeypatch); auth = _auth(path)

    assert _post(c, auth, name="tokyo.test1243.eth", kind="membership").status_code == 400
    assert _post(c, auth, name="nyhvb.tokyo.test1243.eth", kind="organization").status_code == 400
    assert _post(c, auth, name="nyhvb.tokyo.test1243.eth", kind="nonsense").status_code == 400
    assert _post(c, auth, name="not an ens name", kind="membership").status_code == 400
    assert _post(c, auth, name="nyhvb.tokyo.test1243.eth", kind="membership",
                 owner="not-a-wallet").status_code == 400
    # Stating a branch the name contradicts is a disagreement we cannot resolve, not a hint.
    assert _post(c, auth, name="nyhvb.tokyo.test1243.eth", kind="membership",
                 branch_label="osaka").status_code == 400


def test_malformed_filters_are_refused_rather_than_ignored(monkeypatch):
    """A filter that is silently dropped lists everything, and everything is the one answer a
    scoped console must never be given."""
    c, path = _client(monkeypatch); auth = _auth(path)

    for query in ("org=NOT valid", "kind=everything", "branch=NOT valid", "org="):
        assert c.get(f"/admin/ens-names?{query}",
                     headers={"Authorization": auth}).status_code == 400


def test_recording_a_name_requires_an_admin_token(monkeypatch):
    """The candidate list decides which names get verified during an indexer outage, so writing
    to it is a control plane write like any other."""
    c, path = _client(monkeypatch); _auth(path)

    assert c.post("/admin/ens-names", json={"name": "x.tokyo.acme.eth",
                                            "kind": "membership"}).status_code == 401
    assert c.get("/admin/ens-names").status_code == 401
