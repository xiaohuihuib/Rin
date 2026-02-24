import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigService } from '../config';
import { createBaseApp } from '../../core/base';
import { createMockDB, createMockEnv, cleanupTestDB } from '../../../tests/fixtures';
import { createTestClient } from '../../../tests/test-api-client';
import type { Database } from 'bun:sqlite';
import { CacheImpl } from '../../utils/cache';

describe('ConfigService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: any;
    let api: ReturnType<typeof createTestClient>;

    beforeEach(async () => {
        const mockDB = createMockDB();
        db = mockDB.db;
        sqlite = mockDB.sqlite;
        env = createMockEnv();

        // Setup app with mock db
        app = createBaseApp(env);
        app.state('db', db);
        app.state('jwt', {
            sign: async (payload: any) => `mock_token_${payload.id}`,
            verify: async (token: string) => token.startsWith('mock_token_') ? { id: 1 } : null,
        });
        app.state('cache', {
            get: async () => undefined,
            set: async () => { },
            delete: async () => { },
            deletePrefix: async () => { },
            clear: async () => { },
            getOrSet: async (key: string, fn: Function) => fn(),
            getOrDefault: async (_key: string, defaultValue: any) => defaultValue,
        });
        app.state('serverConfig', {
            get: async (_key: string) => undefined,
            set: async (_key: string, _value: any, _autoSave?: boolean) => { },
            save: async () => { },
            all: async () => [],
            getOrDefault: async (_key: string, defaultValue: any) => defaultValue,
        });
        app.state('clientConfig', {
            get: async (_key: string) => undefined,
            set: async (_key: string, _value: any, _autoSave?: boolean) => { },
            save: async () => { },
            all: async () => [],
            getOrDefault: async (_key: string, defaultValue: any) => defaultValue,
        });

        // Register service
        ConfigService(app);

        // Create test API client
        api = createTestClient(app, env);

        // Create test user
        await createTestUser();
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    async function createTestUser() {
        sqlite.exec(`
            INSERT INTO users (id, username, openid, avatar, permission) 
            VALUES (1, 'testuser', 'gh_test', 'avatar.png', 1)
        `);
    }

    describe('GET /config/:type - Get config', () => {
        it('should get client config without authentication', async () => {
            const result = await api.config.get('client');

            expect(result.error).toBeUndefined();
            expect(result.data).toBeDefined();
        });

        it('should require authentication for server config', async () => {
            const result = await api.config.get('server');

            expect(result.error).toBeDefined();
            expect(result.error?.status).toBe(401);
        });

        it('should allow admin to get server config', async () => {
            const result = await api.config.get('server', { token: 'mock_token_1' });

            expect(result.error).toBeUndefined();
            expect(result.data).toBeDefined();
        });

        it('should return 400 for invalid config type', async () => {
            const result = await api.config.get('invalid' as any, { token: 'mock_token_1' });

            expect(result.error).toBeDefined();
            expect(result.error?.status).toBe(400);
        });

        it('should mask sensitive fields in server config', async () => {
            // Set some AI config with API key
            sqlite.exec(`
                INSERT INTO info (key, value) VALUES 
                ('ai_summary.api_key', 'secret_key_123')
            `);

            const result = await api.config.get('server', { token: 'mock_token_1' });

            expect(result.error).toBeUndefined();
            // API key should be masked
            expect(result.data?.['ai_summary.api_key']).toBe('••••••••');
        });
    });

    describe('POST /config/:type - Update config', () => {
        it('should require authentication to update config', async () => {
            const result = await api.config.update('client', {
                'site.name': 'New Name'
            });

            expect(result.error).toBeDefined();
            expect(result.error?.status).toBe(401);
        });

        it('should allow admin to update client config', async () => {
            const result = await api.config.update('client', {
                'site.name': 'New Site Name',
                'site.description': 'New Description'
            }, { token: 'mock_token_1' });

            expect(result.error).toBeUndefined();
        });

        it('should allow admin to update server config', async () => {
            const result = await api.config.update('server', {
                'webhook_url': 'https://example.com/webhook'
            }, { token: 'mock_token_1' });

            expect(result.error).toBeUndefined();
        });

        it('should save AI config to database', async () => {
            const result = await api.config.update('server', {
                'ai_summary.enabled': 'true',
                'ai_summary.provider': 'openai',
                'ai_summary.model': 'gpt-4o-mini'
            }, { token: 'mock_token_1' });

            expect(result.error).toBeUndefined();

            // Verify AI config was saved
            const dbResult = sqlite.prepare("SELECT * FROM info WHERE key LIKE 'ai_summary.%'").all();
            expect(dbResult.length).toBeGreaterThan(0);
        });

        it('should return 400 for invalid config type', async () => {
            const result = await api.config.update('invalid' as any, {
                'key': 'value'
            }, { token: 'mock_token_1' });

            expect(result.error).toBeDefined();
            expect(result.error?.status).toBe(400);
        });
    });

    describe('DELETE /config/cache - Clear cache', () => {
        it('should require authentication to clear cache', async () => {
            const result = await api.config.clearCache();

            expect(result.error).toBeDefined();
            expect(result.error?.status).toBe(401);
        });

        it('should allow admin to clear cache', async () => {
            const result = await api.config.clearCache({ token: 'mock_token_1' });

            expect(result.error).toBeUndefined();
        });

        it('should not clear server config when clearing cache', async () => {
            // Create real cache and config instances
            const realCache = new CacheImpl(db, env, 'cache', 'database');
            const realServerConfig = new CacheImpl(db, env, 'server.config', 'database');
            const realClientConfig = new CacheImpl(db, env, 'client.config', 'database');

            // Set some cache data
            await realCache.set('feed_1', 'feed_data_1');
            await realCache.set('feed_2', 'feed_data_2');

            // Set some config data
            await realServerConfig.set('webhook_url', 'https://example.com/webhook');
            await realServerConfig.set('secret_key', 'secret123');
            await realClientConfig.set('site.name', 'My Site');
            await realClientConfig.set('site.description', 'My Description');

            // Update app to use real instances
            app.state('cache', realCache);
            app.state('serverConfig', realServerConfig);
            app.state('clientConfig', realClientConfig);

            // Clear cache as admin
            const result = await api.config.clearCache({ token: 'mock_token_1' });
            expect(result.error).toBeUndefined();

            // Verify cache is cleared
            const cacheData = await realCache.all();
            expect(cacheData.size).toBe(0);

            // Verify server config is NOT cleared
            const webhookUrl = await realServerConfig.get('webhook_url');
            const secretKey = await realServerConfig.get('secret_key');
            expect(webhookUrl).toBe('https://example.com/webhook');
            expect(secretKey).toBe('secret123');

            // Verify client config is NOT cleared
            const siteName = await realClientConfig.get('site.name');
            const siteDesc = await realClientConfig.get('site.description');
            expect(siteName).toBe('My Site');
            expect(siteDesc).toBe('My Description');

            // Verify configs can still be retrieved via API
            const clientConfigResult = await api.config.get('client');
            expect(clientConfigResult.error).toBeUndefined();
            expect(clientConfigResult.data?.['site.name']).toBe('My Site');

            const serverConfigResult = await api.config.get('server', { token: 'mock_token_1' });
            expect(serverConfigResult.error).toBeUndefined();
            expect(serverConfigResult.data?.['webhook_url']).toBe('https://example.com/webhook');
        });

        it('should only clear cache entries with type="cache"', async () => {
            // Create real instances
            const publicCache = new CacheImpl(db, env, 'cache', 'database');
            const serverConfig = new CacheImpl(db, env, 'server.config', 'database');
            const clientConfig = new CacheImpl(db, env, 'client.config', 'database');

            // Set data in all three stores
            await publicCache.set('search_results', { query: 'test', results: [] });
            await serverConfig.set('api_key', 'sk-1234567890');
            await clientConfig.set('theme', 'dark');

            // Update app state
            app.state('cache', publicCache);
            app.state('serverConfig', serverConfig);
            app.state('clientConfig', clientConfig);

            // Clear cache
            const result = await api.config.clearCache({ token: 'mock_token_1' });
            expect(result.error).toBeUndefined();

            // Verify only public cache is cleared
            expect(await publicCache.get('search_results')).toBeUndefined();
            expect(await serverConfig.get('api_key')).toBe('sk-1234567890');
            expect(await clientConfig.get('theme')).toBe('dark');
        });
    });

    describe('POST /config/test-ai - Test AI configuration', () => {
        it('should require authentication to test AI', async () => {
            const result = await api.post('/config/test-ai', {
                provider: 'openai',
                model: 'gpt-4o-mini'
            });

            expect(result.error).toBeDefined();
            expect(result.error?.status).toBe(401);
        });

        it('should allow admin to test AI configuration', async () => {
            // Note: This test may fail if AI service is not available
            // In a real test environment, we would mock the AI service
            const result = await api.post('/config/test-ai', {
                provider: 'openai',
                model: 'gpt-4o-mini',
                api_url: 'https://api.openai.com/v1',
                testPrompt: 'Hello'
            }, { token: 'mock_token_1' });

            // Should either succeed or fail gracefully (not 401)
            expect(result.error?.status).not.toBe(401);
        });
    });
});
