import { writeFile, rename } from 'node:fs/promises';
import { createTransitClient } from '../public/transit-provider.js';

// One manual public-data request. No account, device position or application secrets.
const data = await createTransitClient().loadCity({ id: 'astana', kind: 'city', center: [71.4304, 51.147] });
if (!data.stops.length || data.partial) throw new Error('Refusing to replace the snapshot with an empty or truncated response.');
const target = new URL('../public/transit-astana-stops.json', import.meta.url);
const temporary = new URL('../public/transit-astana-stops.json.tmp', import.meta.url);
data.bounds = [50.967, 71.1504, 51.327, 71.7104];
data.sourceUrl = 'https://overpass-api.de/api/interpreter';
data.license = 'ODbL-1.0';
await writeFile(temporary, `${JSON.stringify(data)}\n`);
await rename(temporary, target);
console.log(`Saved ${data.stops.length} stops and ${data.routes.length} route directions; OSM base ${data.osmTimestamp}.`);
