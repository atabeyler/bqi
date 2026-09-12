/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Kept as a compatibility token; the BQI identity maps the former
        // gold accent to a silver/cyan scale across existing components.
        gold: { DEFAULT: '#bcefff', dark: '#5fbcd3', light: '#ecfbff' },
        navy: { DEFAULT: '#0a0e1a', light: '#11172a', accent: '#1a2244' },
        crimson: '#c8102e'
      },
      fontFamily: {
        serif: ['"Times New Roman"', 'Georgia', 'serif'],
        display: ['"Cinzel"', '"Times New Roman"', 'serif'],
        mono: ['"JetBrains Mono"', 'monospace']
      },
      animation: {
        'pulse-gold': 'pulseGold 2s ease-in-out infinite',
        'radar': 'radar 4s linear infinite',
        'float': 'float 6s ease-in-out infinite',
        'shimmer': 'shimmer 3s linear infinite'
      },
      keyframes: {
        pulseGold: {
          '0%, 100%': { opacity: 1, transform: 'scale(1)' },
          '50%': { opacity: 0.6, transform: 'scale(1.1)' }
        },
        radar: {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' }
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        }
      }
    }
  },
  plugins: []
};
