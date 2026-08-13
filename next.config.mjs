/** @type {import('next').NextConfig} */
const nextConfig = {
  // Permet à l'import ESM de fonctionner correctement dans les lib/
  experimental: {
    // Pas besoin de configuration spéciale pour Next.js 14 App Router
  },
};

export default nextConfig;
