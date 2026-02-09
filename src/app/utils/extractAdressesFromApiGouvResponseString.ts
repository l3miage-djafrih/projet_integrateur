import { parse } from "papaparse"
import { isArrayOfGouvBatchedAdressResultP, mapGouvBatchedAdressResultToAdresse } from "../services/gouvBatchedAdressResult"
import { Adresse } from "../data/adresse"

export function extractAdressesFromApiGouvResponseString(responseString: string): Promise<readonly Adresse[]> {
    return Promise.resolve(
        parse(responseString.trim(), { delimiter: ';', header: true })
    ).then(
        parsedRes => parsedRes.data
    ).then(
        isArrayOfGouvBatchedAdressResultP
    ).then(
        L => Promise.allSettled(L.map(mapGouvBatchedAdressResultToAdresse))
    ).then(
        L => L.filter(r => r.status === "fulfilled").map(r => r.value )
    )
}