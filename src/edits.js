// Hand edits to the map, kept in code so they apply for everyone.
//
// HIDDEN_BUILDINGS: building IDs (the HYD-XXXX-YYYY code shown in the building panel) to leave out of the model.
// EXTRA_ROADS: roads that are missing from the map data. Each one is a straight line from [lat, lon] to [lat, lon]
//   (add more points for a bend); cls is the road class: motorway, trunk, primary, secondary, tertiary, minor or service.
export const HIDDEN_BUILDINGS = [
  'HYD-0HUB-0IBI',
];

// WATER_TANKS: building IDs that are really water tanks: the box is replaced by a round tank on the same footprint.
export const WATER_TANKS = [
  'HYD-0NJB-0FR1',
];

export const EXTRA_ROADS = [
  { name: 'Char Kaman link', cls: 'tertiary', points: [[17.36332, 78.47503], [17.36211, 78.47473]] },
];
