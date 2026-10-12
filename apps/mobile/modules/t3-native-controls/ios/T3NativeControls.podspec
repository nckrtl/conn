Pod::Spec.new do |s|
  s.name           = 'T3NativeControls'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for T3 Code mobile.'
  s.description    = 'UIKit-backed controls that match native iOS navigation chrome.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # The iOS 27.0 and 27.1 SDKs ship the same Swift compiler, so Swift cannot
    # tell whether the 27.1-only hinge APIs exist. Mark the 27.0 SDKs instead.
    'T3_SDK_SWIFT_CONDITIONS[sdk=iphoneos27.0*]' => 'T3_IOS_27_0_SDK',
    'T3_SDK_SWIFT_CONDITIONS[sdk=iphonesimulator27.0*]' => 'T3_IOS_27_0_SDK',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) $(T3_SDK_SWIFT_CONDITIONS)',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
