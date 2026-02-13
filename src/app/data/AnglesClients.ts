import { Adresse } from "./adresse";

export interface AngleClient{
    angle:number;
    adresse:Adresse
}

export interface AnglesClients{
    angles:AngleClient[];
}