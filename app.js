"use strict";

const PokemonGO = require("pokemon-go-node-api");
const elasticsearch = require("elasticsearch");

const players = require("./players");
const areas = require("./areas");

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const precision = 0.0005;
const interval = 5000;

const getNextLocation = getNextLocationFactory(areas);
const encountered = {};
const client = new elasticsearch.Client({
	host: "http://elastic:changeme@localhost:9200"
});

players.forEach(player => {
	player.pokeio = new PokemonGO.Pokeio();
	player.pokeio.init(player.username, player.password, getNextLocation(), player.provider, err => heartbeat(err, player));
});

function heartbeat(err, player) {
	if (err) throw err;
	player.pokeio.Heartbeat((err, hb) => handleHeartbeat(err, hb, player));
}

function handleHeartbeat(err, hb, player) {
	if (err) throw err;
	if (hb.cells.length === 0) throw new Error(`${player.username} has been banned`);

	hb.cells.forEach(cell => {
		cell.Fort.forEach(handleFort);
		cell.MapPokemon.forEach(encounter => handleEncounter(encounter, player.pokeio.pokemonlist));
	});

	player.pokeio.SetLocation(getNextLocation(), (err, location) => {
		console.log(`moved to ${location.latitude},${location.longitude}`);
		setTimeout(() => heartbeat(err, player), interval);
	});
}

function handleFort(fort) {
	if (encountered[fort.FortId]) return;
	encountered[fort.FortId] = true;

	fort.LastModifiedMs = parseFloat(fort.LastModifiedMs.toString());
	if (fort.GymPoints) fort.GymPoints = parseFloat(fort.GymPoints.toString());

	fort.location = `${fort.Latitude},${fort.Longitude}`;
	console.log(`found fort at ${fort.location}`);

	client.index({
		index: "pokemon-go-fort",
		type: fort.FortType === 1 ? "pokestop" : "gym",
		id: fort.FortId,
		body: fort
	});
}

function handleEncounter(encounter, pokedex) {
	encounter.EncounterId = encounter.EncounterId.toString();
	encounter.ExpirationTimeMs = parseFloat(encounter.ExpirationTimeMs.toString());
	if (encountered[encounter.EncounterId] || encounter.ExpirationTimeMs < 0) return;
	encountered[encounter.EncounterId] = true;

	encounter.timestamp = new Date();
	encounter.expiration = new Date(encounter.ExpirationTimeMs);
	encounter.location = `${encounter.Latitude},${encounter.Longitude}`;
	encounter.url = `https://www.google.com/maps/search/${encounter.location}`;
	console.log(`found encounter at ${encounter.location}`);

	const entry = pokedex[encounter.PokedexTypeId - 1];
	encounter.name = entry.name;
	encounter.type = entry.type;

	handleSpawnPoint({
		SpawnPointId: encounter.SpawnPointId,
		Latitude: encounter.Latitude,
		Longitude: encounter.Longitude,
		expiration: encounter.expiration
	});

	client.index({
		index: "pokemon-go-encounter",
		type: "encounter",
		id: encounter.EncounterId,
		body: encounter
	});
}

function handleSpawnPoint(spawnPoint) {
	if (encountered[spawnPoint.SpawnPointId]) return;
	encountered[spawnPoint.SpawnPointId] = true;

	spawnPoint.expiration = new Date(spawnPoint.expiration.getTime() % HOUR);
	spawnPoint.spawn = new Date(spawnPoint.expiration.getTime() - 15 * MINUTE);
	spawnPoint.location = `${spawnPoint.Latitude},${spawnPoint.Longitude}`;
	console.log(`found spawn point at ${spawnPoint.location}`);

	client.index({
		index: "pokemon-go-spawn-point",
		type: "spawn-point",
		id: spawnPoint.SpawnPointId,
		body: spawnPoint
	});
}

function getNextLocationFactory(areas) {
	const locations = [];
	areas.forEach(area => {
		for (let lat = area.latLng[0] - area.radius; lat <= area.latLng[0] + area.radius; lat += precision) {
			for (let lng = area.latLng[1] - area.radius; lng <= area.latLng[1] + area.radius; lng += precision) {
				locations.push(getLocation(lat, lng));
			}
		}
	});

	let i = 0;
	return () => locations[i++ % locations.length];
}

function getLocation(lat, lng) {
	return {
		type: "coords",
		coords: {
			latitude: lat,
			longitude: lng
		}
	};
}
