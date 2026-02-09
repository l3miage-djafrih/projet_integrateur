import { Icon, icon, LatLngExpression, marker, Marker } from "leaflet";

export type MarkerColor = 'blue' | 'gold' | 'red' | 'green' | 'orange' | 'yellow' | 'violet' | 'grey' | 'black';
export function getMarker(
	latng: LatLngExpression,
	color: MarkerColor = 'blue'
): Marker {
    return marker(latng, {
	icon: icon({
		...Icon.Default.prototype.options,
		iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,// 'assets/marker-icon.png',
		iconRetinaUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
		shadowUrl: 'assets/marker-shadow.png'
   })
});
}
