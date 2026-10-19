import type { NextConfig } from "next";

const samples = ["./fixtures/sample-courses/**/*"];

const nextConfig: NextConfig = {
  // Sample course fixtures are read from disk at request time; make sure deployments ship them.
  outputFileTracingIncludes: {
    "/api/samples": samples,
    "/api/samples/\\[language\\]/load": samples,
  },
};

export default nextConfig;
