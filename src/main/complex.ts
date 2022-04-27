import { IComplex } from "../types/types";
import { RpcClient } from "./rpc-client";

export class Complex implements IComplex {
    constructor(
        private rpcClient: RpcClient,
    ) {}

    async bestBlock() {
        try {
            const bbhRes = await this.rpcClient.call('getbestblockhash');
            if (bbhRes.error || !bbhRes.data) throw new Error(`getbestblockhash Error: ${bbhRes.error}`);
            const bbRes = await this.rpcClient.call('getblock', bbhRes.data);
            if (bbRes.error || !bbRes.data?.height) throw new Error(`getblock Error: ${bbRes.error}`);
            const height: number = bbRes.data.height;
            return { data: height };
        } catch (error: any) {
            return { error: error.message };
        }
    }

}
