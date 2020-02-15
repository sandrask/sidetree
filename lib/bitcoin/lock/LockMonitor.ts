import BitcoinClient from '../BitcoinClient';
import BitcoinError from '../BitcoinError';
import BitcoinLockTransactionModel from '../models/BitcoinLockTransactionModel';
import ErrorCode from '../ErrorCode';
import LockIdentifier from '../models/LockIdentifierModel';
import LockIdentifierSerializer from './LockIdentifierSerializer';
import LockResolver from './LockResolver';
import LockTransactionModel from './../models/LockTransactionModel';
import LockTransactionType from './../enums/LockTransactionType';
import MongoDbLockTransactionStore from './MongoDbLockTransactionStore';
import ValueTimeLockModel from './../../common/models/ValueTimeLockModel';

/**
 * Structure (internal to this class) to track the information about lock.
 */
interface LockInformation {
  currentValueTimeLock: ValueTimeLockModel | undefined;
  latestSavedLockInfo: LockTransactionModel | undefined;

  // Need to add a 'state'
}

/**
 * Encapsulates functionality to monitor and create/remove amount locks on bitcoin.
 */
export default class LockMonitor {

  private periodicPollTimeoutId: number | undefined;

  private currentValueTimeLock: LockInformation | undefined;

  private lockResolver: LockResolver;

  constructor (
    private bitcoinClient: BitcoinClient,
    private lockTransactionStore: MongoDbLockTransactionStore,
    private pollPeriodInSeconds: number,
    private desiredLockAmountInSatoshis: number,
    private lockPeriodInBlocks: number,
    private firstLockFeeAmountInSatoshis: number) {

    this.lockResolver = new LockResolver(this.bitcoinClient);
  }

  /**
   * Initializes this object by either creating a lock/relock or returning the amount
   * back to the target bitcoin wallet if needed.
   */
  public async initialize (): Promise<void> {
    await this.periodicPoll();
  }

  private async periodicPoll (intervalInSeconds: number = this.pollPeriodInSeconds) {

    try {
      // Defensive programming to prevent multiple polling loops even if this method is externally called multiple times.
      if (this.periodicPollTimeoutId) {
        clearTimeout(this.periodicPollTimeoutId);
      }

      this.currentValueTimeLock = await this.resolveCurrentValueTimeLock();

      // Not: ALSO need to check the state (pending/confirmed etc) below
      const validCurrentLockExist = this.currentValueTimeLock.currentValueTimeLock !== undefined;

      const lockRequired = this.desiredLockAmountInSatoshis > 0;

      if (lockRequired && !validCurrentLockExist) {
        await this.handleCreatingNewLock(this.desiredLockAmountInSatoshis);
      }

      if (lockRequired && validCurrentLockExist) {
        await this.handleExistingLockRenewal(
          this.currentValueTimeLock.currentValueTimeLock!,
          this.currentValueTimeLock.latestSavedLockInfo!,
          this.desiredLockAmountInSatoshis);
      }

      if (!lockRequired && validCurrentLockExist) {
        await this.releaseLockAndSaveItToDb(this.currentValueTimeLock.currentValueTimeLock!, this.desiredLockAmountInSatoshis);
      }

      this.currentValueTimeLock = await this.resolveCurrentValueTimeLock();
    } catch (e) {
      const message = `An error occured during periodic poll: ${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
      console.error(message);
    } finally {
      this.periodicPollTimeoutId = setTimeout(this.periodicPoll.bind(this), 1000 * intervalInSeconds);
    }
  }

  private async resolveCurrentValueTimeLock (): Promise<LockInformation> {

    const currentValueTimeLockrmation: LockInformation = {
      currentValueTimeLock: undefined,
      latestSavedLockInfo: undefined
    };

    const lastSavedLock = await this.lockTransactionStore.getLastLock();
    currentValueTimeLockrmation.latestSavedLockInfo = lastSavedLock;

    if (!lastSavedLock) {
      return currentValueTimeLockrmation;
    }

    if (lastSavedLock.type === LockTransactionType.ReturnToWallet) {
      // Check if the transaction is actually written on blockchain
      if (!(await this.isTransactionWrittenOnBitcoin(lastSavedLock.transactionId))) {
        await this.rebroadcastTransaction(lastSavedLock);
      }

      return currentValueTimeLockrmation;
    }

    try {
      // If we're here then it means that we have saved some information about a lock (which we
      // still need to resolve)
      const lastLockIdentifier: LockIdentifier = {
        transactionId: lastSavedLock.transactionId,
        redeemScriptAsHex: lastSavedLock.redeemScriptAsHex
      };

      currentValueTimeLockrmation.currentValueTimeLock = await this.lockResolver.resolveLockIdentifierAndThrowOnError(lastLockIdentifier);

    } catch (e) {

      // If the transaction was not found on the bitcoin
      if (e instanceof BitcoinError && e.code === ErrorCode.LockResolverTransactionNotFound) {
        await this.rebroadcastTransaction(lastSavedLock);

      } else {
        // This is an unhandle-able error and we need to just rethrow ... the following will
        // mantain the original stacktrace
        throw (e);
      }
    }

    return currentValueTimeLockrmation;
  }

  private async rebroadcastTransaction (lastSavedLock: LockTransactionModel): Promise<void> {
    // So we had some transaction information saved but the transaction was never found on the
    // blockchain. Either the transaction was broadcasted and we're just waiting for it to be
    // actually written or maybe this node died before it could actually broadcast the transaction.
    // Since we don't which case it is and bitcoin will prevent 'double-spending' the same
    // transaction, we can just rebroadcast the same transaction.
    const lockTransactionFromLastSavedLock: BitcoinLockTransactionModel = {
      redeemScriptAsHex: lastSavedLock.redeemScriptAsHex,
      serializedTransactionObject: lastSavedLock.rawTransaction,
      transactionId: lastSavedLock.transactionId,

      // Setting a 'fake' fee because the model requires it but broadcasting does not really
      // require it so this is not going to have any effect when trying to broadcast.
      transactionFee: 0
    };

    await this.bitcoinClient.broadcastLockTransaction(lockTransactionFromLastSavedLock);
  }

  private async isTransactionWrittenOnBitcoin (transactionId: string): Promise<boolean> {
    try {
      await this.bitcoinClient.getRawTransaction(transactionId);

      // no exception thrown == transaction found.
      return true;
    } catch (e) {
      console.info(`Transaction with id: ${transactionId} was not found on the bitcoin. Error: ${JSON.stringify(e, Object.getOwnPropertyNames(e))}`);
    }

    return false;
  }

  private async handleCreatingNewLock (desiredLockAmountInSatoshis: number): Promise<LockTransactionModel> {

    // When creating the first lock, we are going to lock an amount more than the amount
    // to account for the fee(s) required when relocking etc. So check whether the target
    // wallet has enough balance.
    const totalLockAmount = desiredLockAmountInSatoshis + this.firstLockFeeAmountInSatoshis;
    const walletBalance = await this.bitcoinClient.getBalanceInSatoshis();

    if (walletBalance <= totalLockAmount) {
      throw new BitcoinError(ErrorCode.LockMonitorNotEnoughBalanceForFirstLock,
                             `Lock amount: ${totalLockAmount}; Wallet balance: ${walletBalance}`);
    }

    return this.createNewLockAndSaveItToDb(totalLockAmount);
  }

  private async handleExistingLockRenewal (
    currentValueTimeLock: ValueTimeLockModel,
    latestSavedLockInfo: LockTransactionModel,
    desiredLockAmountInSatoshis: number): Promise<void> {

    // If desired amount is < amount already locked ??

    const currentBlockTime = await this.bitcoinClient.getCurrentBlockHeight();

    // Just return if we're not close to expiry
    if (currentValueTimeLock.unlockTransactionTime - currentBlockTime > 1) {
      return;
    }

    // If the desired lock amount is different from prevoius then just return the amount to
    // the wallet and let the next poll iteration start a new lock.
    if (latestSavedLockInfo.desiredLockAmountInSatoshis !== desiredLockAmountInSatoshis) {
      await this.releaseLockAndSaveItToDb(currentValueTimeLock, desiredLockAmountInSatoshis);
      return;
    }

    // If we have gotten to here then we need to try renew.
    try {

      await this.renewExistingLockAndSaveItToDb(currentValueTimeLock, desiredLockAmountInSatoshis);
    } catch (e) {

      // If there is not enough balance for the relock then just release the lock. Let the next
      // iteration of the polling to try and create a new lock.
      if (e instanceof BitcoinError && e.code === ErrorCode.LockMonitorNotEnoughBalanceForRelock) {
        await this.releaseLockAndSaveItToDb(currentValueTimeLock, desiredLockAmountInSatoshis);
      } else {
        // This is an unexpected error at this point ... rethrow as this is needed to be investigated.
        throw (e);
      }
    }
  }

  private async createNewLockAndSaveItToDb (desiredLockAmountInSatoshis: number): Promise<LockTransactionModel> {

    const lockUntilBlock = await this.bitcoinClient.getCurrentBlockHeight() + this.lockPeriodInBlocks;
    const lockTransaction = await this.bitcoinClient.createLockTransaction(desiredLockAmountInSatoshis, lockUntilBlock);

    const lockInfoToSave = this.createLockInfoToSave(lockTransaction, LockTransactionType.Create, desiredLockAmountInSatoshis);

    await this.lockTransactionStore.addLock(lockInfoToSave);

    await this.bitcoinClient.broadcastLockTransaction(lockTransaction);

    return lockInfoToSave;
  }

  private async renewExistingLockAndSaveItToDb (currentValueTimeLock: ValueTimeLockModel, desiredLockAmountInSatoshis: number): Promise<LockTransactionModel> {

    const currentLockIdentifier = LockIdentifierSerializer.deserialize(currentValueTimeLock.identifier);
    const lockUntilBlock = await this.bitcoinClient.getCurrentBlockHeight() + this.lockPeriodInBlocks;

    const relockTransaction =
      await this.bitcoinClient.createRelockTransaction(
          currentLockIdentifier.transactionId,
          currentValueTimeLock.unlockTransactionTime,
          lockUntilBlock);

    // If the transaction fee is making the relock amount less than the desired amount
    if (currentValueTimeLock.amountLocked - relockTransaction.transactionFee < desiredLockAmountInSatoshis) {
      throw new BitcoinError(
        ErrorCode.LockMonitorNotEnoughBalanceForRelock,
        // tslint:disable-next-line: max-line-length
        `The relocking fee (${relockTransaction.transactionFee} satoshis) is causing the relock amount to go below the desired lock amount: ${desiredLockAmountInSatoshis}`);
    }

    const lockInfoToSave = this.createLockInfoToSave(relockTransaction, LockTransactionType.Relock, desiredLockAmountInSatoshis);

    await this.lockTransactionStore.addLock(lockInfoToSave);

    await this.bitcoinClient.broadcastLockTransaction(relockTransaction);

    return lockInfoToSave;
  }

  private async releaseLockAndSaveItToDb (currentValueTimeLock: ValueTimeLockModel, desiredLockAmountInSatoshis: number): Promise<LockTransactionModel> {
    const currentLockIdentifier = LockIdentifierSerializer.deserialize(currentValueTimeLock.identifier);

    const releaseLockTransaction =
      await this.bitcoinClient.createReleaseLockTransaction(
        currentLockIdentifier.transactionId,
        currentValueTimeLock.unlockTransactionTime);

    const lockInfoToSave = this.createLockInfoToSave(releaseLockTransaction, LockTransactionType.ReturnToWallet, desiredLockAmountInSatoshis);

    await this.lockTransactionStore.addLock(lockInfoToSave);

    await this.bitcoinClient.broadcastLockTransaction(releaseLockTransaction);

    return lockInfoToSave;
  }

  private createLockInfoToSave (
    lockTxn: BitcoinLockTransactionModel,
    lockTxnType: LockTransactionType,
    desiredLockAmountInSatoshis: number): LockTransactionModel {

    return {
      desiredLockAmountInSatoshis: desiredLockAmountInSatoshis,
      rawTransaction: lockTxn.serializedTransactionObject,
      transactionId: lockTxn.transactionId,
      redeemScriptAsHex: lockTxn.redeemScriptAsHex,
      createTimestamp: Date.now(),
      type: lockTxnType
    };
  }
}
