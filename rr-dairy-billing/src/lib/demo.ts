/**
 * Demo mode (VITE_DEMO=1, set by vercel.json): a visitor opens the site and lands inside a ready-made dairy — no
 * server, no sign-in. Everything lives in their own browser, so nobody can affect anyone else's copy.
 */
export const IS_DEMO: boolean = import.meta.env?.VITE_DEMO === '1'

export const DEMO_STORE = 'Shree Gokul Dairy'
export const DEMO_PINS = { owner: '1234', manager: '2222', cashier: '3333' } as const
