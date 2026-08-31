This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## AI food photo estimates

The food log photo estimator calls an OpenAI-compatible AI gateway from the
Rust backend (see `infra/cliproxyapi/` for the CLIProxyAPI service that wraps
a ChatGPT/Codex subscription). Configure it on the backend environment:

```bash
AI_GATEWAY_URL=http://cliproxyapi.railway.internal:8317/v1/chat/completions
AI_GATEWAY_API_KEY=...
AI_GATEWAY_MODELS=gpt-5.6-luna(low),gpt-5.6-luna(medium)
AI_GATEWAY_MODEL_TIMEOUT_MS=20000
```

`AI_GATEWAY_MODELS` and the timeout are optional (the values above are the
defaults). Set `AI_GATEWAY_MODELS` on the web service too if customized, so
the admin benchmark page shows the configured models.

## API access

Signed-in users can create scoped personal access tokens at `/settings/api`.
API v1 lives under `/api/v1/*`, OpenAPI JSON is available at
`/api/v1/openapi.json`, and readable docs are at `/docs/api`.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
