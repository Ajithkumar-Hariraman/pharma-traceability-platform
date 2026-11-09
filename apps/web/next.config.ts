import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@pharma/contracts'],
  poweredByHeader: false,
};
export default config;
