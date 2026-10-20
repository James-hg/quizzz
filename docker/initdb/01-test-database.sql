-- Runs once, when the Postgres volume is first created: a separate database for integration
-- tests, so they can never touch development data.
CREATE DATABASE quizzz_test;
