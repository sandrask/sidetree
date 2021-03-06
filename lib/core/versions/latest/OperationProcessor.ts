import CreateOperation from './CreateOperation';
import DidResolutionModel from '../../models/DidResolutionModel';
import DocumentComposer from './DocumentComposer';
import ErrorCode from './ErrorCode';
import IOperationProcessor, { ApplyResult } from '../../interfaces/IOperationProcessor';
import Multihash from './Multihash';
import NamedAnchoredOperationModel from '../../models/NamedAnchoredOperationModel';
import OperationType from '../../enums/OperationType';
import RecoverOperation from './RecoverOperation';
import RevokeOperation from './RevokeOperation';
import SidetreeError from '../../SidetreeError';
import UpdateOperation from './UpdateOperation';

/**
 * Implementation of OperationProcessor. Uses a OperationStore
 * that might, e.g., use a backend database for persistence.
 * All 'processing' is deferred to resolve time, with process()
 * simply storing the operation in the store.
 */
export default class OperationProcessor implements IOperationProcessor {
  public constructor (private didMethodName: string) { }

  public async apply (
    namedAnchoredOperationModel: NamedAnchoredOperationModel,
    didResolutionModel: DidResolutionModel
  ): Promise<ApplyResult> {
    let validOperation = false;

    try {
      if (namedAnchoredOperationModel.type === OperationType.Create) {
        validOperation = await this.applyCreateOperation(namedAnchoredOperationModel, didResolutionModel);
      } else if (namedAnchoredOperationModel.type === OperationType.Update) {
        validOperation = await this.applyUpdateOperation(namedAnchoredOperationModel, didResolutionModel);
      } else if (namedAnchoredOperationModel.type === OperationType.Recover) {
        validOperation = await this.applyRecoverOperation(namedAnchoredOperationModel, didResolutionModel);
      } else if (namedAnchoredOperationModel.type === OperationType.Revoke) {
        validOperation = await this.applyRevokeOperation(namedAnchoredOperationModel, didResolutionModel);
      } else {
        throw new SidetreeError(ErrorCode.OperationProcessorUnknownOperationType);
      }

    } catch (error) {
      console.log(`Invalid operation ${error}.`);
    }

    // If the operation was not applied - it means the operation is not valid, we log some info in case needed for debugging.
    try {
      if (!validOperation) {
        const index = namedAnchoredOperationModel.operationIndex;
        const time = namedAnchoredOperationModel.transactionTime;
        const number = namedAnchoredOperationModel.transactionNumber;
        const did = didResolutionModel.didDocument ? didResolutionModel.didDocument.id : undefined;
        console.debug(`Ignored invalid operation for DID '${did}' in transaction '${number}' at time '${time}' at operation index ${index}.`);
      }
    } catch (error) {
      console.log(`Failed logging ${error}.`);
      // If logging fails, just move on.
    }

    return { validOperation };
  }

  /**
   * @returns `true` if operation was successfully applied, `false` otherwise.
   */
  private async applyCreateOperation (
    namedAnchoredOperationModel: NamedAnchoredOperationModel,
    didResolutionModel: DidResolutionModel
  ): Promise<boolean> {
    // If we have seen a previous create operation.
    if (didResolutionModel.didDocument) {
      return false;
    }

    const operation = await CreateOperation.parse(namedAnchoredOperationModel.operationBuffer);

    const document = operation.operationData.document;

    // Ensure actual operation data hash matches expected operation data hash.
    const isValidOperationData = Multihash.isValidHash(operation.encodedOperationData, operation.suffixData.operationDataHash);
    if (!isValidOperationData) {
      return false;
    }

    const internalDocumentModel = {
      didUniqueSuffix: operation.didUniqueSuffix,
      document,
      recoveryKey: operation.suffixData.recoveryKey,
      nextRecoveryOtpHash: operation.suffixData.nextRecoveryOtpHash,
      nextUpdateOtpHash: operation.operationData.nextUpdateOtpHash
    };

    // Transform the internal document state to a DID document.
    // NOTE: this transformation will be moved out and only apply to the final internal document state by the time #266 is completed.
    const didDocument = DocumentComposer.transformToExternalDocument(this.didMethodName, internalDocumentModel);

    didResolutionModel.didDocument = didDocument;
    didResolutionModel.metadata = {
      recoveryKey: internalDocumentModel.recoveryKey,
      lastOperationTransactionNumber: namedAnchoredOperationModel.transactionNumber,
      nextRecoveryOtpHash: internalDocumentModel.nextRecoveryOtpHash,
      nextUpdateOtpHash: internalDocumentModel.nextUpdateOtpHash
    };

    return true;
  }

  /**
   * @returns `true` if operation was successfully applied, `false` otherwise.
   */
  private async applyUpdateOperation (
    namedAnchoredOperationModel: NamedAnchoredOperationModel,
    didResolutionModel: DidResolutionModel
  ): Promise<boolean> {

    const didDocument = didResolutionModel.didDocument;

    // If we have not seen a valid create operation yet.
    if (didDocument === undefined) {
      return false;
    }

    const operation = await UpdateOperation.parse(namedAnchoredOperationModel.operationBuffer);

    // Verify the actual OTP hash against the expected OTP hash.
    const isValidOtp = Multihash.isValidHash(operation.updateOtp, didResolutionModel.metadata!.nextUpdateOtpHash!);
    if (!isValidOtp) {
      return false;
    }

    // Verify the operation data hash against the expected operation data hash.
    const isValidOperationData = Multihash.isValidHash(operation.encodedOperationData, operation.signedOperationDataHash.payload);
    if (!isValidOperationData) {
      return false;
    }

    const resultingDocument = await DocumentComposer.applyUpdateOperation(operation, didResolutionModel.didDocument);

    didResolutionModel.didDocument = resultingDocument;
    didResolutionModel.metadata!.lastOperationTransactionNumber = namedAnchoredOperationModel.transactionNumber;
    didResolutionModel.metadata!.nextUpdateOtpHash = operation.operationData.nextUpdateOtpHash;

    return true;
  }

  /**
   * @returns `true` if operation was successfully applied, `false` otherwise.
   */
  private async applyRecoverOperation (
    namedAnchoredOperationModel: NamedAnchoredOperationModel,
    didResolutionModel: DidResolutionModel
  ): Promise<boolean> {

    const operation = await RecoverOperation.parse(namedAnchoredOperationModel.operationBuffer);

    // Verify the actual OTP hash against the expected OTP hash.
    const isValidOtp = Multihash.isValidHash(operation.recoveryOtp, didResolutionModel.metadata!.nextRecoveryOtpHash!);
    if (!isValidOtp) {
      return false;
    }

    // Verify the signature.
    const signatureIsValid = await operation.signedOperationDataJws.verifySignature(didResolutionModel.metadata!.recoveryKey!);
    if (!signatureIsValid) {
      return false;
    }

    // Verify the actual operation data hash against the expected operation data hash.
    const isValidOperationData = Multihash.isValidHash(operation.encodedOperationData, operation.signedOperationData.operationDataHash);
    if (!isValidOperationData) {
      return false;
    }

    const internalDocumentModel = {
      didUniqueSuffix: operation.didUniqueSuffix,
      document: operation.operationData.document,
      recoveryKey: operation.signedOperationData.recoveryKey,
      nextRecoveryOtpHash: operation.signedOperationData.nextRecoveryOtpHash,
      nextUpdateOtpHash: operation.operationData.nextUpdateOtpHash
    };

    // Transform the internal document state to a DID document.
    // NOTE: this transformation will be moved out and only apply to the final internal document state by the time #266 is completed.
    const document = DocumentComposer.transformToExternalDocument(this.didMethodName, internalDocumentModel);

    didResolutionModel.didDocument = document;
    didResolutionModel.metadata!.recoveryKey = operation.signedOperationData.recoveryKey,
    didResolutionModel.metadata!.lastOperationTransactionNumber = namedAnchoredOperationModel.transactionNumber;
    didResolutionModel.metadata!.nextRecoveryOtpHash = operation.signedOperationData.nextRecoveryOtpHash,
    didResolutionModel.metadata!.nextUpdateOtpHash = operation.operationData.nextUpdateOtpHash;
    return true;
  }

  /**
   * @returns `true` if operation was successfully applied, `false` otherwise.
   */
  private async applyRevokeOperation (
    namedAnchoredOperationModel: NamedAnchoredOperationModel,
    didResolutionModel: DidResolutionModel
  ): Promise<boolean> {

    const operation = await RevokeOperation.parse(namedAnchoredOperationModel.operationBuffer);

    // Verify the actual OTP hash against the expected OTP hash.
    const isValidOtp = Multihash.isValidHash(operation.recoveryOtp, didResolutionModel.metadata!.nextRecoveryOtpHash!);
    if (!isValidOtp) {
      return false;
    }

    // Verify the signature.
    const signatureIsValid = await operation.signedOperationDataJws.verifySignature(didResolutionModel.metadata!.recoveryKey!);
    if (!signatureIsValid) {
      return false;
    }

    // The operation passes all checks.
    didResolutionModel.metadata!.recoveryKey = undefined;
    didResolutionModel.metadata!.lastOperationTransactionNumber = namedAnchoredOperationModel.transactionNumber;
    didResolutionModel.metadata!.nextRecoveryOtpHash = undefined;
    didResolutionModel.metadata!.nextUpdateOtpHash = undefined;
    return true;
  }
}
