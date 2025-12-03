import { describe, it, expect, beforeEach } from 'vitest';
import { Router, NAMESPACE_SEPARATOR } from '../src/core/router.js';

describe('Router', () => {
  let router: Router;

  beforeEach(() => {
    // Create a router without a registry (we'll test namespace methods directly)
    router = new Router();
  });

  describe('createNamespacedName', () => {
    it('creates a namespaced name with separator', () => {
      const result = router.createNamespacedName('filesystem', 'read_file');
      expect(result).toBe(`filesystem${NAMESPACE_SEPARATOR}read_file`);
    });

    it('handles empty server ID', () => {
      const result = router.createNamespacedName('', 'read_file');
      expect(result).toBe(`${NAMESPACE_SEPARATOR}read_file`);
    });

    it('handles empty tool name', () => {
      const result = router.createNamespacedName('filesystem', '');
      expect(result).toBe(`filesystem${NAMESPACE_SEPARATOR}`);
    });

    it('preserves underscores in original names', () => {
      const result = router.createNamespacedName('my_server', 'my_tool_name');
      expect(result).toBe(`my_server${NAMESPACE_SEPARATOR}my_tool_name`);
    });
  });

  describe('parseNamespacedName', () => {
    it('parses a valid namespaced name', () => {
      const result = router.parseNamespacedName(`filesystem${NAMESPACE_SEPARATOR}read_file`);
      expect(result).not.toBeNull();
      expect(result?.serverId).toBe('filesystem');
      expect(result?.originalName).toBe('read_file');
    });

    it('returns null for name without separator', () => {
      const result = router.parseNamespacedName('read_file');
      expect(result).toBeNull();
    });

    it('returns null for empty server ID', () => {
      const result = router.parseNamespacedName(`${NAMESPACE_SEPARATOR}read_file`);
      expect(result).toBeNull();
    });

    it('returns null for empty original name', () => {
      const result = router.parseNamespacedName(`filesystem${NAMESPACE_SEPARATOR}`);
      expect(result).toBeNull();
    });

    it('handles multiple underscores in original name', () => {
      const result = router.parseNamespacedName(`server${NAMESPACE_SEPARATOR}my_tool_name`);
      expect(result).not.toBeNull();
      expect(result?.serverId).toBe('server');
      expect(result?.originalName).toBe('my_tool_name');
    });
  });

  describe('createNamespacedUri', () => {
    it('creates a namespaced URI with scheme format', () => {
      const result = router.createNamespacedUri('filesystem', 'file:///path/to/file');
      expect(result).toBe('filesystem://file:///path/to/file');
    });

    it('handles simple paths', () => {
      const result = router.createNamespacedUri('notes', 'daily/2024-01-01.md');
      expect(result).toBe('notes://daily/2024-01-01.md');
    });
  });

  describe('parseNamespacedUri', () => {
    it('parses a valid namespaced URI', () => {
      const result = router.parseNamespacedUri('filesystem://file:///path/to/file');
      expect(result).not.toBeNull();
      expect(result?.serverId).toBe('filesystem');
      expect(result?.originalName).toBe('file:///path/to/file');
    });

    it('handles URIs with query strings', () => {
      const result = router.parseNamespacedUri('api://users?id=123&format=json');
      expect(result).not.toBeNull();
      expect(result?.serverId).toBe('api');
      expect(result?.originalName).toBe('users?id=123&format=json');
    });

    it('returns null for invalid URI format', () => {
      const result = router.parseNamespacedUri('not-a-valid-uri');
      expect(result).toBeNull();
    });

    it('requires server ID to start with a letter', () => {
      const result = router.parseNamespacedUri('123server://path');
      expect(result).toBeNull();
    });

    it('accepts server ID with numbers and underscores', () => {
      const result = router.parseNamespacedUri('server_v2://path');
      expect(result).not.toBeNull();
      expect(result?.serverId).toBe('server_v2');
    });
  });

  describe('round-trip conversions', () => {
    it('name: create -> parse returns original values', () => {
      const serverId = 'my_server';
      const name = 'tool_name';

      const namespaced = router.createNamespacedName(serverId, name);
      const parsed = router.parseNamespacedName(namespaced);

      expect(parsed).not.toBeNull();
      expect(parsed?.serverId).toBe(serverId);
      expect(parsed?.originalName).toBe(name);
    });

    it('uri: create -> parse returns original values', () => {
      const serverId = 'filesystem';
      const uri = 'file:///home/user/document.txt';

      const namespaced = router.createNamespacedUri(serverId, uri);
      const parsed = router.parseNamespacedUri(namespaced);

      expect(parsed).not.toBeNull();
      expect(parsed?.serverId).toBe(serverId);
      expect(parsed?.originalName).toBe(uri);
    });
  });
});

describe('NAMESPACE_SEPARATOR', () => {
  it('is a double underscore', () => {
    expect(NAMESPACE_SEPARATOR).toBe('__');
  });
});
