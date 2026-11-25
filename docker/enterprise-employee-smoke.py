"""Exercise the disposable employee HTTPS endpoint without printing credentials."""
import http.client
import json
from pathlib import Path
import re
import secrets
import ssl
import sys
import time


def check(condition, message):
    if not condition:
        raise ValueError(message)


def run(port, owner_token):
    host = '127.0.0.1'
    origin = f'https://{host}:{port}'
    tls = ssl.create_default_context(cafile=str(Path(__file__).with_name('ca.pem')))
    auth = '/api/enterprise/auth/'
    send = '/api/enterprise/private-chat/send'

    def call(path, status, body=None, cookie=None, bearer=None):
        headers = {'Host': f'{host}:{port}'}
        if bearer:
            headers['Authorization'] = 'Bearer ' + bearer
        if cookie:
            headers['Cookie'] = cookie
        if body is not None:
            headers.update({'Origin': origin, 'Content-Type': 'application/json'})
            body = json.dumps(body).encode()
        connection = http.client.HTTPSConnection(host, 8443, timeout=20, context=tls)
        try:
            connection.request('GET' if body is None else 'POST', path, body, headers)
            response = connection.getresponse()
            check(response.status == status, f'{path} returned HTTP {response.status}, expected {status}')
            data = response.read(65537)
            check(len(data) <= 65536, 'Fixture response exceeded its size bound')
            return response.headers, data
        finally:
            connection.close()

    owner = '/api/enterprise/owner/'
    person = {'personId': 'alice'}
    scope = {**person, 'botId': 'helper'}
    call('/owner', 200)
    call(owner + 'invite', 401, person)
    _, data = call(owner + 'invite', 201, person, bearer=owner_token)
    token = json.loads(data)['token']
    check(re.fullmatch(r'[A-Za-z0-9_-]{43}', token), 'Invalid fixture invite')
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
    call(owner + 'transcript', 401, scope, cookie)
    _, data = call(owner + 'transcript', 200, scope, bearer=owner_token)
    check(json.loads(data)['turns'] == [], 'Expected empty private transcript')
    rule = {**scope, 'id': 'edit', 'roomId': None, 'directory': '/home/node/smoke-state/owned',
            'operation': 'create', 'effect': 'allow', 'purpose': 'Create the fixture note'}
    # The owner admission allows 8 owner requests per minute per client address;
    # Reset the admission window before the rule and audit calls.
    time.sleep(61)
    call(owner + 'rule', 201, {'action': 'create', 'rule': rule}, bearer=owner_token)
    prompt = {'botId': 'helper', 'text': 'Create the fixture note'}
    call(send, 401, prompt)
    call(send, 403, {**prompt, 'botId': 'foreign'}, cookie)
    created = chat(call, send, prompt, cookie)
    denied = chat(call, send, {**prompt, 'text': 'Modify the fixture note'}, cookie)
    check(created != denied, 'Expected distinct request IDs')
    _, data = call(owner + 'transcript', 200, scope, bearer=owner_token)
    turns = json.loads(data)['turns']
    check({turn['requestId'] for turn in turns} == {created, denied}, 'Transcript did not contain the scoped turns')
    _, data = call(owner + 'audit', 200, {'operation': 'audit', 'query': scope}, bearer=owner_token)
    audit = json.loads(data)
    check(audit['nextOffset'] is None, 'Expected one page of fixture audit records')
    check([(event['type'], event['requestId'], event['operation'], event['verdict']) for event in audit['events']] == [
        ('file-authorization', created, 'create', 'allowed'),
        ('file-effect', created, 'create', 'allowed'),
        ('file-authorization', denied, 'modify', 'denied'),
    ], 'Unexpected worker audit events')
    call(owner + 'rule', 200, {'action': 'edit', 'rule': {**rule, 'purpose': 'Updated fixture purpose'}}, bearer=owner_token)
    call(owner + 'rule', 200, {'action': 'retire', 'rule': {'id': rule['id']}}, bearer=owner_token)
    call(owner + 'revoke', 204, person, bearer=owner_token)
    call(auth + 'session', 401, cookie=cookie)
    call(send, 401, prompt, cookie)
    return created, denied


def chat(call, send, prompt, cookie):
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
        owner_token = sys.stdin.readline(128).strip()
        check(re.fullmatch(r'[A-Za-z0-9_-]{43}', owner_token), 'Invalid fixture owner token')
        print(*run(int(sys.argv[1]), owner_token), sep='\n')
    except (ValueError, OSError, http.client.HTTPException, IndexError, KeyError, TypeError) as error:
        message = str(error) if type(error) is ValueError else type(error).__name__
        sys.exit(f'Employee HTTPS smoke failed: {message}')
