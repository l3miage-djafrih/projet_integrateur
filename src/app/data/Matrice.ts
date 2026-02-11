import * as zod from "zod";


/**
 * représente une matrice de distances
 */



export interface LocationSnappedDistance{
  location:number[];
  snapped_distance:number
}

// une matrice de distance 
export interface Matrice {
  distances: number[][];
  durations:number[][];
  sources:LocationSnappedDistance[]
  destinations:LocationSnappedDistance[];
}

const LocationSnappedDistanceSchema=zod.object({
  location:zod.array(zod.number()),
  snapped_distance:zod.number()
})

const matriceSchema = zod.object({
  distances: zod.array(zod.array(zod.number())),
  durations:zod.array(zod.array(zod.number())),
  sources:zod.array(LocationSnappedDistanceSchema),
  destinations:zod.array(LocationSnappedDistanceSchema)
});



// transformation du résultat de l'appel api à un object Matrice 

export function parseMatrice(data: unknown): Matrice {
   
  return matriceSchema.parse(data);
  
}



export function transformJsontoMatrice(data:any):Matrice{
  return JSON.parse(data);
}


