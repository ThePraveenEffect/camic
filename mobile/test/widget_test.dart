import 'package:flutter_test/flutter_test.dart';
import 'package:camic/main.dart';

void main() {
  testWidgets('Camic app builds', (tester) async {
    await tester.pumpWidget(const CamicApp());
    expect(find.text('Camic'), findsOneWidget);
  });
}
