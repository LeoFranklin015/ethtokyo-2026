import base64
import time
from urllib.parse import parse_qs, urlencode
import requests
from db import get_db


# key_placement values and what they do:
#   url_path     — key appended to URL: {base}/{api_key}/{subpath}
#   header       — key injected as custom header (key_header_name)
#   bearer_token — key injected as Authorization: Bearer {api_key}
#   basic_auth   — inject as Authorization: Basic base64({api_key_b64_user}:{api_key})
#                  api_key_b64_user = username (empty = use empty username)
#   query_param  — key injected as query param (query_param_name)
#   no_auth      — no key injection (open upstream or handled by client headers)


def _build_url(resource: dict, subpath: str) -> str:
    base = resource["upstream_url"].rstrip("/")
    path = subpath.lstrip("/")
    if resource["key_placement"] == "url_path":
        key = resource.get("api_key") or ""
        return f"{base}/{key}/{path}" if key else f"{base}/{path}"
    return f"{base}/{path}" if path else base


def _inject_auth(resource: dict, headers: dict, params: dict) -> None:
    placement = resource["key_placement"]
    key = resource.get("api_key") or ""

    if placement == "header":
        name = resource.get("key_header_name") or "X-Api-Key"
        headers[name] = key

    elif placement == "bearer_token":
        headers["Authorization"] = f"Bearer {key}"

    elif placement == "basic_auth":
        user = resource.get("api_key_b64_user") or ""
        cred = base64.b64encode(f"{user}:{key}".encode()).decode()
        headers["Authorization"] = f"Basic {cred}"

    elif placement == "query_param":
        name = resource.get("query_param_name") or "api_key"
        params[name] = key

    # url_path handled in _build_url; no_auth does nothing


def forward(resource: dict, method: str, subpath: str, incoming_req) -> tuple:
    """
    Forward request to upstream with auth injection.
    Returns (content_bytes, status, req_bytes, resp_bytes, duration_ms, upstream_error).
    """
    start = time.monotonic()

    url = _build_url(resource, subpath)

    # Hop-by-hop headers to drop
    skip = {"host", "content-length", "transfer-encoding", "connection",
            "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "upgrade"}
    headers = {k: v for k, v in incoming_req.headers if k.lower() not in skip}

    # Parse existing query string, then inject auth params
    qs_raw = incoming_req.query_string.decode()
    params = {}
    if qs_raw:
        for k, vs in parse_qs(qs_raw, keep_blank_values=True).items():
            params[k] = vs[0] if len(vs) == 1 else vs

    _inject_auth(resource, headers, params)

    if params:
        url = f"{url}?{urlencode(params, doseq=True)}"

    body = incoming_req.get_data()
    req_bytes = len(body)

    MAX_RESP_BYTES = 50 * 1024 * 1024  # 50 MB

    try:
        resp = requests.request(
            method=method,
            url=url,
            headers=headers,
            data=body,
            stream=True,
            timeout=30,
            allow_redirects=False,
            verify=True,
        )

        chunks = []
        size = 0
        for chunk in resp.iter_content(65536):
            size += len(chunk)
            if size > MAX_RESP_BYTES:
                resp.close()
                return None, 413, req_bytes, size, 0, "response_too_large"
            chunks.append(chunk)
        content = b"".join(chunks)
        resp_bytes = len(content)

        duration_ms = int((time.monotonic() - start) * 1000)
        return content, resp.status_code, req_bytes, resp_bytes, duration_ms, None

    except requests.exceptions.ConnectionError as e:
        duration_ms = int((time.monotonic() - start) * 1000)
        return None, 502, req_bytes, 0, duration_ms, f"connection_error: {str(e)[:120]}"
    except requests.exceptions.Timeout:
        duration_ms = int((time.monotonic() - start) * 1000)
        return None, 502, req_bytes, 0, duration_ms, "timeout"
    except Exception as e:
        duration_ms = int((time.monotonic() - start) * 1000)
        return None, 502, req_bytes, 0, duration_ms, f"unexpected: {str(e)[:120]}"


def record_event(db, session_id, ip, group_id, resource_id,
                 method, path, status, upstream_error,
                 req_bytes, resp_bytes, duration_ms):
    db.execute(
        """INSERT INTO usage_events
           (ts,session_id,ip,group_id,resource_id,method,path,
            status,upstream_error,req_bytes,resp_bytes,duration_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (int(time.time()), session_id, ip, group_id, resource_id,
         method, path, status, upstream_error, req_bytes, resp_bytes, duration_ms)
    )
    # Update session bandwidth counters
    if session_id:
        db.execute(
            "UPDATE sessions SET bytes_in=bytes_in+?, bytes_out=bytes_out+? WHERE id=?",
            (req_bytes or 0, resp_bytes or 0, session_id)
        )
    db.commit()
