# MCP Gateway API Reference

## Table of Contents

- [Authentication](#authentication)
- [MCP Protocol Endpoints](#mcp-protocol-endpoints)
- [Admin API Endpoints](#admin-api-endpoints)
- [Error Codes](#error-codes)

---

## Authentication

All API endpoints require Bearer token authentication.

### Request Header

```
Authorization: Bearer <token>
```

### Example

```bash
curl -H "Authorization: Bearer sk-your-secret-token" \
  https://mcp.yourdomain.com/admin/health
```

### Error Responses

**401 Unauthorized** - Missing or invalid token

```json
{
  "error": "Unauthorized",
  "message": "Missing or invalid Authorization header. Expected: Bearer <token>"
}
```

**403 Forbidden** - Valid token but insufficient permissions (admin endpoints)

```json
{
  "error": "Forbidden",
  "message": "Admin access required"
}
```

---

## MCP Protocol Endpoints

### GET /sse

Establish a Server-Sent Events connection for the MCP protocol.

**Response Headers:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Initial Event:**

```
event: endpoint
data: {"endpoint":"/message","sessionId":"uuid-here"}
```

**Message Events:**

```
event: message
data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

---

### POST /message

Send a JSON-RPC message within an SSE session.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | Bearer token |
| `Content-Type` | Yes | `application/json` |
| `X-Session-ID` | No | Session ID from SSE connection |

**Request Body:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "filesystem__read_file",
    "arguments": {
      "path": "/home/user/file.txt"
    }
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "File contents here..."
      }
    ]
  }
}
```

---

### POST /rpc

Direct JSON-RPC endpoint (stateless, no SSE session required).

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | Bearer token |
| `Content-Type` | Yes | `application/json` |

**Supported Methods:**

| Method | Description |
|--------|-------------|
| `initialize` | Initialize the MCP connection |
| `ping` | Health check |
| `tools/list` | List all available tools |
| `tools/call` | Execute a tool |
| `resources/list` | List all available resources |
| `resources/read` | Read a resource |
| `prompts/list` | List all available prompts |
| `prompts/get` | Get a prompt |

---

## Admin API Endpoints

### GET /admin/status

Get the overall gateway status.

**Response:**

```json
{
  "success": true,
  "data": {
    "initialized": true,
    "sessions": 2,
    "registry": {
      "totalServers": 3,
      "healthyServers": 2,
      "unhealthyServers": 0,
      "startingServers": 1,
      "stoppedServers": 0,
      "servers": [...]
    }
  }
}
```

---

### GET /admin/servers

List all registered servers.

**Response:**

```json
{
  "success": true,
  "data": {
    "total": 3,
    "healthy": 2,
    "unhealthy": 1,
    "servers": [
      {
        "id": "filesystem",
        "transport": "stdio",
        "health": "healthy",
        "capabilities": {
          "tools": 5,
          "resources": 0,
          "prompts": 0
        },
        "stats": {
          "requestCount": 150,
          "errorCount": 2,
          "avgResponseTime": 45.3,
          "uptime": 3600000
        }
      }
    ]
  }
}
```

---

### GET /admin/servers/:id

Get detailed information about a specific server.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Server ID |

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "filesystem",
    "transport": "stdio",
    "health": "healthy",
    "connected": true,
    "config": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
      "lazyLoad": false,
      "timeout": 60000,
      "maxRetries": 3
    },
    "capabilities": {
      "tools": ["read_file", "write_file", "list_directory", "search_files", "get_file_info"],
      "resources": [],
      "prompts": [],
      "serverInfo": {
        "name": "filesystem",
        "version": "1.0.0"
      }
    },
    "stats": {
      "requestCount": 150,
      "errorCount": 2,
      "lastRequestTime": "2024-01-15T10:30:00Z",
      "lastErrorTime": "2024-01-15T09:15:00Z",
      "avgResponseTime": 45.3,
      "uptime": 3600000
    }
  }
}
```

**Error Response (404):**

```json
{
  "success": false,
  "error": "Server 'invalid_id' not found"
}
```

---

### POST /admin/servers

Register a new server dynamically.

**Request Body:**

```json
{
  "id": "new_server",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-memory"],
  "env": {},
  "enabled": true,
  "lazyLoad": false,
  "timeout": 60000,
  "maxRetries": 3
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique server identifier |
| `transport` | string | Yes | `"stdio"` or `"sse"` |
| `command` | string | Stdio | Command to spawn |
| `args` | string[] | No | Command arguments |
| `url` | string | SSE | SSE endpoint URL |
| `env` | object | No | Environment variables |
| `enabled` | boolean | No | Default: `true` |
| `lazyLoad` | boolean | No | Default: `false` |
| `timeout` | number | No | Default: `60000` |
| `maxRetries` | number | No | Default: `3` |

**Response (201):**

```json
{
  "success": true,
  "message": "Server 'new_server' registered successfully",
  "data": {
    "id": "new_server",
    "health": "starting",
    "connected": false
  }
}
```

**Error Response (409 Conflict):**

```json
{
  "success": false,
  "error": "Server 'existing_id' is already registered"
}
```

---

### DELETE /admin/servers/:id

Unregister and stop a server.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Server ID |

**Response:**

```json
{
  "success": true,
  "message": "Server 'server_id' unregistered successfully"
}
```

---

### POST /admin/servers/:id/restart

Restart a server.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Server ID |

**Response:**

```json
{
  "success": true,
  "message": "Server 'server_id' restarted successfully",
  "data": {
    "health": "healthy",
    "connected": true
  }
}
```

---

### GET /admin/tools

List all available namespaced tools.

**Response:**

```json
{
  "success": true,
  "data": {
    "total": 12,
    "tools": [
      {
        "namespacedName": "filesystem__read_file",
        "serverId": "filesystem",
        "originalName": "read_file",
        "description": "Read the complete contents of a file"
      },
      {
        "namespacedName": "github__create_issue",
        "serverId": "github",
        "originalName": "create_issue",
        "description": "Create a new issue in a repository"
      }
    ]
  }
}
```

---

### GET /admin/health

Health check endpoint for monitoring.

**Response (200 OK):**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "servers": {
    "total": 3,
    "healthy": 3,
    "unhealthy": 0
  }
}
```

**Response (503 Service Unavailable):**

```json
{
  "status": "unhealthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "servers": {
    "total": 3,
    "healthy": 0,
    "unhealthy": 3
  }
}
```

---

## Error Codes

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created (server registered) |
| 400 | Bad Request (invalid input) |
| 401 | Unauthorized (missing/invalid token) |
| 403 | Forbidden (insufficient permissions) |
| 404 | Not Found (server not registered) |
| 409 | Conflict (server already exists) |
| 500 | Internal Server Error |
| 503 | Service Unavailable (health check failed) |

### JSON-RPC Error Codes

| Code | Message | Description |
|------|---------|-------------|
| -32600 | Invalid Request | Invalid JSON-RPC request |
| -32601 | Method not found | Unknown MCP method |
| -32602 | Invalid params | Invalid method parameters |
| -32603 | Internal error | Server-side error |
| -32000 | Server error | Sub-server or routing error |

### Example Error Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Server 'filesystem' is not healthy",
    "data": {
      "correlationId": "req_1705312200_abc123"
    }
  }
}
```
