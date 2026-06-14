import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { geocodeAddress, getDistanceFromLatLonInKm } from "../../utils/geocode.js";
import { BRANCHES } from "../../db/branch-seed.js";
import { console } from "inspector/promises";

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}




export const findNearestBranchTool = createTool({
  id: "find-nearest-branch",
  description: "Finds the nearest FBNBank branch based on a customer's provided address or latitude/longitude coordinates.",
  inputSchema: z.object({
    latitude: z.number().optional().describe("The latitude if the user shared a GPS location"),
    longitude: z.number().optional().describe("The longitude if the user shared a GPS location"),
    address: z.string().optional().describe("The text address if the user typed their location"),
  }),
  execute: async ({ latitude, longitude, address }) => {

    console.log("Received input for find-nearest-branch tool:", { latitude, longitude, address });
    
    let searchLat = latitude;
    let searchLng = longitude;

    if (address && (!latitude || !longitude)) {
        const geocodeResult = await geocodeAddress(address);

        if (!geocodeResult) {
        return {
            error: `Could not find coordinates for address: ${address}`,
        };
        }

        searchLat = geocodeResult.lat;
        searchLng = geocodeResult.lng;
    }

    if (searchLat == null || searchLng == null) {
        return {
            error: "Could not determine coordinates from the provided location.",
        };
    }

    const branchesWithDistance = BRANCHES
        .map((branch) => ({
        ...branch,
        distanceKm: getDistanceFromLatLonInKm(
            searchLat,
            searchLng,
            branch.lat,
            branch.lng
        ),
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
    
    console.log("Branches with calculated distances:", branchesWithDistance);

    return {
        nearestBranch: branchesWithDistance[0],
            searchedLocation: {
            latitude: searchLat,
            longitude: searchLng,
        },
    };
  },
});
