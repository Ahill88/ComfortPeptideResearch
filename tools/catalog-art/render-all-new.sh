#!/bin/bash
# Launch 42 renders in batches of 4, serial between batches
cd /Users/andrewsilva/Documents/ComfortPeptideResearch
mkdir -p /Users/andrewsilva/.hermes/cache/scratch/render-logs

SLUGS="reta tirz semax selank klow ipamorelin tesamorelin mots-c nad-plus kpv epithalon thymosin-alpha-1 cjc-1295-ipamorelin bac-water"
VIEWS="overview detail angle"
PARALLEL=4

counter=0
for slug in $SLUGS; do
  for view in $VIEWS; do
    echo "[$counter/42] Starting ${slug}-${view}"
    /Volumes/Blender/Blender.app/Contents/MacOS/Blender --background --python tools/catalog-art/render.py -- "$slug" "$view" --cpu > "/Users/andrewsilva/.hermes/cache/scratch/render-logs/${slug}-${view}.log" 2>&1
    counter=$((counter + 1))
    echo "[$counter/42] Done ${slug}-${view}"
    
    # Wait for parallel slots to finish
    if (( counter % PARALLEL == 0 )); then
      echo "Batch complete ($counter/42), pausing..."
      sleep 1
    fi
  done
done

echo "ALL_RENDER_COMPLETE"
