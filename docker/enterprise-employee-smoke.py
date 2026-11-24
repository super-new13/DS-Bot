"""Exercise the disposable employee HTTPS endpoint without printing credentials."""
import http.client
import json
from pathlib import Path
import re
import secrets
import ssl
import sys


def check(condition, message):
    if not condition:
        raise ValueError(message)


def run(scratch, port):
    host = '127.0.0.1'
    origin = f'https://{host}:{port}'
    tls = ssl.create_default_context(cafile=str(scratch / 'ca/ca.pem'))
    auth = '/api/enterprise/auth/'
    send = '/api/enterprise/private-chat/send'

    def call(path, status, body=None, cookie=None):
        headers = {}
        if cookie:
            headers['Cookie'] = cookie
        if body is not None:
            headers.update({'Origin': origin, 'Content-Type': 'application/json'})
            body = json.dumps(body).encode()
        connection = http.client.HTTPSConnection(host, port, timeout=20, context=tls)
        try:
            connection.request('GET' if body is None else 'POST', path, body, headers)
            response = connection.getresponse()
            check(response.status == status, f'{path} returned HTTP {response.status}, expected {status}')
            data = response.read(65537)
            check(len(data) <= 65536, 'Fixture response exceeded its size bound')
            return response.headers, data
        finally:
            connection.close()

    token = (scratch / 'invite').read_text().strip()
    check(re.fullmatch(r'[A-Za-z0-9_-]{43}', token), 'Fixture invite is missing or invalid')
    (scratch / 'invite').unlink()
    password = secrets.token_urlsafe(32)
    call('/', 200)
    call(auth + 'redeem', 204, {'token': token, 'password': password})
    headers, _ = call(auth + 'login', 204, {'personId': 'alice', 'password': password})
    cookie, *attributes = headers.get('Set-Cookie', '').split(';')
    attributes = {attribute.strip().lower() for attribute in attributes}
    check(cookie.startswith('__Host-dsbot-employee='), 'Expected the employee session cookie')
    check({'secure', 'httponly', 'samesite=strict', 'path=/'} <= attributes, 'Incorrect cookie attributes')
    _, data = call(auth + 'session', 200, cookie=cookie)
    check(json.loads(data) == {'personId': 'alice'}, 'Unexpected employee session')
    prompt = {'botId': 'helper', 'text': 'Update the fixture note'}
    call(send, 401, prompt)
    call(send, 403, {**prompt, 'botId': 'foreign'}, cookie)
    headers, data = call(send, 200, prompt, cookie)
    check(headers.get_content_type() == 'text/event-stream', 'Chat did not produce SSE')
    events = []
    for frame in data.decode().strip().split('\n\n'):
        check(frame.startswith('data: '), 'Unexpected SSE frame')
        events.append(json.loads(frame[6:]))
    request_id = events[0].get('requestId', '')
    check(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', request_id), 'Invalid SSE request ID')
    check(events[0]['type'] == 'queued' and all(event.get('requestId') == request_id for event in events),
          'Unexpected SSE request scope')
    check(events[-1] == {'type': 'done', 'requestId': request_id, 'status': 'completed'}
          and all(event.get('type') in {'delta', 'reply'} for event in events[1:-1]), 'Missing completed SSE terminal event')
    return request_id


if __name__ == '__main__':
    try:
        print(run(Path(sys.argv[1]), int(sys.argv[2])))
    except (ValueError, OSError, http.client.HTTPException, IndexError, KeyError, TypeError) as error:
        message = str(error) if type(error) is ValueError else type(error).__name__
        sys.exit(f'Employee HTTPS smoke failed: {message}')
