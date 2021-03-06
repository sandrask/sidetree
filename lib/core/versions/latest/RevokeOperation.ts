import Encoder from './Encoder';
import ErrorCode from './ErrorCode';
import JsonAsync from './util/JsonAsync';
import Jws from './util/Jws';
import Operation from './Operation';
import OperationModel from './models/OperationModel';
import OperationType from '../../enums/OperationType';
import SidetreeError from '../../SidetreeError';

interface SignedOperationDataModel {
  didUniqueSuffix: string;
  recoveryOtp: string;
}

/**
 * A class that represents a revoke operation.
 */
export default class RevokeOperation implements OperationModel {

  /** The original request buffer sent by the requester. */
  public readonly operationBuffer: Buffer;

  /** The unique suffix of the DID. */
  public readonly didUniqueSuffix: string;

  /** The type of operation. */
  public readonly type: OperationType;

  /** Encoded one-time password for the operation. */
  public readonly recoveryOtp: string;

  /** Signed encoded operation data. */
  public readonly signedOperationDataJws: Jws;

  /** Decoded signed operation data payload. */
  public readonly signedOperationData: SignedOperationDataModel;

  /**
   * NOTE: should only be used by `parse()` and `parseObject()` else the contructed instance could be invalid.
   */
  private constructor (
    operationBuffer: Buffer,
    didUniqueSuffix: string,
    recoveryOtp: string,
    signedOperationDataJws: Jws,
    signedOperationData: SignedOperationDataModel
  ) {
    this.operationBuffer = operationBuffer;
    this.type = OperationType.Revoke;
    this.didUniqueSuffix = didUniqueSuffix;
    this.recoveryOtp = recoveryOtp;
    this.signedOperationDataJws = signedOperationDataJws;
    this.signedOperationData = signedOperationData;
  }

  /**
   * Parses the given buffer as a `UpdateOperation`.
   */
  public static async parse (operationBuffer: Buffer): Promise<RevokeOperation> {
    const operationJsonString = operationBuffer.toString();
    const operationObject = await JsonAsync.parse(operationJsonString);
    const revokeOperation = await RevokeOperation.parseObject(operationObject, operationBuffer);
    return revokeOperation;
  }

  /**
   * Parses the given operation object as a `RevokeOperation`.
   * The `operationBuffer` given is assumed to be valid and is assigned to the `operationBuffer` directly.
   * NOTE: This method is purely intended to be used as an optimization method over the `parse` method in that
   * JSON parsing is not required to be performed more than once when an operation buffer of an unknown operation type is given.
   */
  public static async parseObject (operationObject: any, operationBuffer: Buffer): Promise<RevokeOperation> {
    const properties = Object.keys(operationObject);
    if (properties.length !== 4) {
      throw new SidetreeError(ErrorCode.RevokeOperationMissingOrUnknownProperty);
    }

    if (operationObject.type !== OperationType.Revoke) {
      throw new SidetreeError(ErrorCode.RevokeOperationTypeIncorrect);
    }

    if (typeof operationObject.didUniqueSuffix !== 'string') {
      throw new SidetreeError(ErrorCode.RevokeOperationMissingOrInvalidDidUniqueSuffix);
    }

    if (typeof operationObject.recoveryOtp !== 'string') {
      throw new SidetreeError(ErrorCode.RevokeOperationRecoveryOtpMissingOrInvalidType);
    }

    if ((operationObject.recoveryOtp as string).length > Operation.maxEncodedOtpLength) {
      throw new SidetreeError(ErrorCode.RevokeOperationRecoveryOtpTooLong);
    }

    const recoveryOtp = operationObject.recoveryOtp;

    const signedOperationDataJws = Jws.parse(operationObject.signedOperationData);
    const signedOperationData = await RevokeOperation.parseSignedOperationDataPayload(
      signedOperationDataJws.payload, operationObject.didUniqueSuffix, recoveryOtp);

    return new RevokeOperation(
      operationBuffer,
      operationObject.didUniqueSuffix,
      recoveryOtp,
      signedOperationDataJws,
      signedOperationData
    );
  }

  private static async parseSignedOperationDataPayload (
    operationDataEncodedString: string, expectedDidUniqueSuffix: string, expectedRecoveryOtp: string): Promise<SignedOperationDataModel> {

    const signedOperationDataJsonString = Encoder.decodeAsString(operationDataEncodedString);
    const signedOperationData = await JsonAsync.parse(signedOperationDataJsonString);

    const properties = Object.keys(signedOperationData);
    if (properties.length !== 2) {
      throw new SidetreeError(ErrorCode.RevokeOperationSignedDataMissingOrUnknownProperty);
    }

    if (signedOperationData.didUniqueSuffix !== expectedDidUniqueSuffix) {
      throw new SidetreeError(ErrorCode.RevokeOperationSignedDidUniqueSuffixMismatch);
    }

    if (signedOperationData.recoveryOtp !== expectedRecoveryOtp) {
      throw new SidetreeError(ErrorCode.RevokeOperationSignedRecoveryOtpMismatch);
    }

    return signedOperationData;
  }
}
