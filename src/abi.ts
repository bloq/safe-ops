import { parseAbi, toEventSelector } from "viem";

export const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

// `txHash` is indexed from 1.4.1 on and in the data before that; see `emittedExecutionSuccess`.
export const EXECUTION_SUCCESS_TOPIC = toEventSelector("ExecutionSuccess(bytes32,uint256)");

/** Safe transaction operations. */
export const CALL = 0;
export const DELEGATE_CALL = 1;

export const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);
