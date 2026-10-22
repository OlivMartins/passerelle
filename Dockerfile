# Passerelle en conteneur : interface, API et ligne de commande, exécutées par Node.js 24.
#   docker build -t passerelle .
#   docker run --rm -p 127.0.0.1:8080:8080 -e PASSERELLE_TOKEN=… passerelle
# Configuration : montez votre fichier sur /etc/passerelle/passerelle.yaml.
# Le binaire autonome et l'unité systemd restent la voie d'installation sur serveur (docs/INSTALL.md).

FROM node:24-slim AS build
WORKDIR /src
# Aucune dépendance npm n'est nécessaire sans le binaire autonome
COPY package.json ./
COPY scripts ./scripts
COPY src ./src
COPY examples ./examples
RUN node scripts/build.mjs --no-binary

FROM node:24-slim
ENV NODE_ENV=production \
    PASSERELLE_LISTEN=0.0.0.0:8080 \
    PASSERELLE_CONFIG=/etc/passerelle/passerelle.yaml
COPY packaging/passerelle.yaml /etc/passerelle/passerelle.yaml
COPY LICENSE NOTICE /opt/passerelle/
COPY --from=build /src/dist/passerelle.cjs /src/dist/passerelle.html /opt/passerelle/
# Utilisateur sans privilège de l'image Node ; compatible avec --read-only et un /tmp en tmpfs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/opt/passerelle/passerelle.cjs"]
CMD ["serve"]
