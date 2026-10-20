FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
RUN npm install --workspace=@helix-field/api
COPY apps/api apps/api
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma && npm run build --workspace=@helix-field/api
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
EXPOSE 3001
CMD ["node", "dist/main.js"]
