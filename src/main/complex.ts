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
            if (bbRes.error || !bbRes.data) throw new Error(`getblock Error: ${bbRes.error}`);
            // The declared type is number. A height the parser returns as a bigint
            // or a decimal string is not one, so it fails the call instead of
            // being passed on under a false type.
            const height: unknown = bbRes.data.height;
            if (typeof height !== 'number') throw new Error('getblock Error: height is not a number');
            return { data: height };
        } catch (error: any) {
            return { error: error.message };
        }
    }

}
