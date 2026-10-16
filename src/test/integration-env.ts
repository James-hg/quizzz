// Point app code at the test database so it can never touch a development database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.STORAGE_DIR ??= "./storage";
