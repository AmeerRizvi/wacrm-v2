import type { MetadataRoute } from 'next'
export default function manifest(): MetadataRoute.Manifest {
  return { id: '/', name: 'wacrm', short_name: 'wacrm', start_url: '/inbox', scope: '/', display: 'standalone', background_color: '#020617', theme_color: '#020617', icons: [192, 512].map(size => ({ src: `/pwa-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })) }
}
