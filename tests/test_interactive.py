from applyburst.interactive import compile_form,identify_field

def test_unknown_sensitive_fields_require_answers():
    fields=[{'selector':'#email','label':'Email address','type':'email','required':True},
            {'selector':'#visa','label':'Do you need visa sponsorship?','type':'select','required':True,'options':[{'label':'Yes','value':'1'},{'label':'No','value':'0'}]},
            {'selector':'#consent','label':'Email me promotional material','type':'checkbox','required':True}]
    result=compile_form(fields,{'name':'Demo Candidate','email':'candidate@example.test'})
    assert len(result['mapping'])==1
    assert len(result['missing'])==2
    assert result['submission_verified'] is False

def test_middle_names_are_not_moved_into_surname():
    fields=[{'selector':'#first','label':'First name','type':'text','required':True},
            {'selector':'#last','label':'Last name','type':'text','required':True}]
    result=compile_form(fields,{'name':'Demo Middle Candidate'})
    assert [item['value'] for item in result['mapping']]==['Demo Middle','Candidate']

def test_closed_options_and_cover_letter_abstention():
    fields=[{'selector':'#country','label':'Country','type':'select','required':True,'options':[{'label':'Canada','value':'ca'}]},
            {'selector':'#cover','label':'Cover letter','type':'file','required':True}]
    assert len(compile_form(fields,{'name':'Demo','resume_path':'resume.docx'})['missing'])==2
    assert identify_field({'label':'Company name','type':'text'}) is None
