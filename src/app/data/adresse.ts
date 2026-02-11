import * as zod from "zod";



export interface Adresse {
    lat: number;
    lng: number;
    name: string;
    postCode: string;
    city: string;
}

export interface ListAdresse{
    adresses:Adresse[];
}




// ajoute d'un schéma zod pour définir le signal adresse 

const SchemaAdresse=zod.object(
    {
        lat:zod.number(),
        lng:zod.number(),
        name:zod.string(),
        postCode:zod.string(),
        city:zod.string()


    }
)

const SchemaListAdresse=zod.object(
    {adresses:zod.array(SchemaAdresse)}
)


// transformation JsontoAdresseSchema


export function JsontoAdresseSChema(data:any):ListAdresse{
    return SchemaListAdresse.parse(data);
}