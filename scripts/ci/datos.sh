#!/usr/bin/env bash
# Rama "datos": copia permanente del archivo semanal (web/data/weekly/), fuera de main. La caché de
# Actions es la copia de cada 30 min; esta, la que no se pierde si la caché desaparece.
#
#   datos.sh pull        trae de la rama las semanas que falten en web/data/weekly/ (no pisa ninguna)
#   datos.sh push [h]    guarda web/data/weekly/ en la rama si el último guardado tiene más de h horas
#                        (20 por defecto: uno al día; 0 = siempre). Solo hace commit si algo cambió.
set -euo pipefail

DIR=web/data/weekly
BRANCH=datos

case "${1:-}" in
  pull)
    if ! git fetch -q --depth=1 origin "$BRANCH" 2>/dev/null; then
      echo "Aún no hay rama $BRANCH"
      exit 0
    fi
    tmp=$(mktemp -d)
    git archive FETCH_HEAD weekly | tar -x -C "$tmp"
    mkdir -p "$DIR"
    n=0
    for f in "$tmp"/weekly/*-W*.json; do
      [ -e "$f" ] || continue
      if [ ! -e "$DIR/$(basename "$f")" ]; then
        cp "$f" "$DIR/"
        n=$((n + 1))
      fi
    done
    echo "Semanas recuperadas de la rama $BRANCH: $n"
    ;;
  push)
    min_h=${2:-20}
    if [ ! -e "$DIR/index.json" ]; then
      echo "No hay archivo semanal que guardar"
      exit 0
    fi
    wt=$(mktemp -d)
    if git fetch -q --depth=1 origin "$BRANCH" 2>/dev/null; then
      age_h=$(( ($(date +%s) - $(git log -1 --format=%ct FETCH_HEAD)) / 3600 ))
      if [ "$age_h" -lt "$min_h" ]; then
        echo "Último guardado en $BRANCH hace ${age_h} h: toca dentro de $((min_h - age_h)) h"
        exit 0
      fi
      git worktree add -q --detach "$wt" FETCH_HEAD
    else
      git worktree add -q --orphan -b "$BRANCH" "$wt" # primera vez: rama sin historia común con main
    fi
    rm -rf "$wt/weekly"
    mkdir -p "$wt/weekly"
    cp "$DIR"/*.json "$wt/weekly/"
    cat > "$wt/README.md" <<'EOF'
# Datos de Mi Diario

Copia permanente del archivo semanal (las noticias más importantes de cada semana, por sección,
con sus resúmenes IA). La escribe el workflow *Actualizar noticias* una vez al día; no se edita a mano.
EOF
    git -C "$wt" add -A
    if git -C "$wt" diff --cached --quiet; then
      echo "Nada nuevo que guardar en $BRANCH"
      exit 0
    fi
    git -C "$wt" -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      commit -q -m "Archivo semanal $(date -u +%F)"
    git -C "$wt" push -q origin "HEAD:refs/heads/$BRANCH"
    echo "Archivo semanal guardado en la rama $BRANCH"
    ;;
  *)
    echo "Uso: $0 pull | push [horas]" >&2
    exit 2
    ;;
esac
