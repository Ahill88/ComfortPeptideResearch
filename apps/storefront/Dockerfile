FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/storefront/package.json apps/storefront/package.json
RUN npm install --workspace=@helix-field/storefront
COPY apps/storefront apps/storefront
RUN npm run build --workspace=@helix-field/storefront
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/storefront/.next/standalone ./
COPY --from=build /app/apps/storefront/.next/static ./apps/storefront/.next/static
EXPOSE 3000
CMD ["node", "apps/storefront/server.js"]
