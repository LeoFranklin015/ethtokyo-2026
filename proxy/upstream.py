import time
import requests
from db import get_db


def forward(resource: dict, method: str, subpath: str, incoming_req) -> tuple:
    """
    Forward request to upstream, inject API key.
    Returns (response_object_or_None, status_code, resp_bytes, duration_ms, upstream_error).
    """
    start = time.monotonic()
    upstream_error = None

    # Build upstream URL
    base = resource["upstream_url"].rstrip("/")
    path = subpath.lstrip("/")

    if resource["key_placement"] == "url_path":
        url = f"{base}/{resource['api_key']}/{path}"
    else:
        url = f"{base}/{path}"

    # Forward headers — drop hop-by-hop
    skip = {"host", "content-length", "transfer-encoding", "connection",
            "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "upgrade"}
    headers = {k: v for k, v in incoming_req.headers if k.lower() not in skip}

    if resource["key_placement"] == "header":
        headers[resource["key_header_name"]] = resource["api_key"]

    # Forward query string
    qs = incoming_req.query_string.decode()
    if qs:
        url = f"{url}?{qs}"

    req_bytes = len(incoming_req.get_data())

    try:
        resp = requests.request(
            method=method,
            url=url,
            headers=headers,
            data=incoming_req.get_data(),
            timeout=30,
            allow_redirects=True,
            stream=True,
        )
        duration_ms = int((time.monotonic() - start) * 1000)
        content = resp.content
        resp_bytes = len(content)
        return resp, resp.status_code, req_bytes, resp_bytes, duration_ms, None

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
    db.commit()
