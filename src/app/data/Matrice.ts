import * as zod from "zod";

/**
 * représente une matrice de distances
 */



export interface Destination{
  location:number[];
  snapped_distance:number
}

// une matrice de distance 
export interface Matrice {
  distances: number[][];
  destinations:Destination[];
}

const DestinationSchema=zod.object({
  location:zod.array(zod.number()),
  snapped_distance:zod.number()
})

const matriceSchema = zod.object({
  distances: zod.array(zod.array(zod.number())),
  destinations:zod.array(DestinationSchema)
});



// transformation du résultat de l'appel api à un object Matrice 

export function parseMatrice(data: unknown): Matrice {
   console.log(data);
  return matriceSchema.parse(data);
  
}



export function transformJsontoMatrice(data:any):Matrice{
  return JSON.parse(data);
}
