import { Injectable } from "@angular/core";
 import * as turf from '@turf/turf';
import { Adresse } from "../data/adresse";
import { AngleClient, AnglesClients } from "../data/AnglesClients";
@Injectable({
  providedIn: 'root',
})

export class Sweep{

   
// exemple de création d'angle pour un seul client , il faut étendre ça à tous les clients 
/*const depot = turf.point([lng0, lat0]);
const client = turf.point([lng, lat]);

const angle = turf.bearing(depot, client);*/


public constructionDesAngles(adresses:readonly Adresse[]):AnglesClients{
    const depot =turf.point([45.21290729674243,5.768314039594716]);

    let angleClient: AngleClient = {
  angle: 0,           // initialisation par défaut
  adresse: { lat: 0, lng: 0 }  // exemple si Adresse = {lat,lng}
};

let mesAngles: AnglesClients = {
  angles: []

};


    

    adresses.forEach((v)=>{
       
        const client=turf.point([v.lat,v.lng]);
        const angle=turf.bearing(depot,client);
        mesAngles.angles.push(
            {
                angle:angle,
                adresse:{
                   lat:v.lat,
                   lng:v.lng
            }
            }
        )

    })
    // à ce stade lsiteAngles représente une liste d'angles ,on doit ensuite la trier en ordre croissant 

   mesAngles.angles.forEach((v)=>{
    console.log("l'adresse ["+v.adresse.lat+","+v.adresse.lng+"]correspent à l'angle"+v.angle)
   })
   

   return mesAngles;

}

//noramizationAngles pour que le tri croissant soit correcte 
public normalizeAngle(angle: number): number {
  return (angle + 360) % 360;
}

/**
 * 
 * @param listeAngles 
 * @returns une liste qui contient des chunks ,chaque chunks contient 50 adresses ,ce qui représente un appel api optimisation 
 */
public constructionChunkes(listeAngles:AnglesClients):Adresse[][]{
   const chunkSize = 50;
    const chunks: Adresse[][] = []; // initialisation vide


    // angles croissant contient les angles et les adresses en ordre croissant des angles 
    const anglesCroissants=[...listeAngles.angles].map((v)=>(
        
        {
            ...v,
            angle:this.normalizeAngle(v.angle)

        }
    )).sort((a,b)=>a.angle-b.angle)


    // adresses Tries

    const adressesTries=anglesCroissants.map((v)=>v.adresse)
// construction des chunks 
    for(let i=0;anglesCroissants.length;i++){
        chunks.push(adressesTries.slice(i,i+chunkSize))
    }


    return chunks

}

}